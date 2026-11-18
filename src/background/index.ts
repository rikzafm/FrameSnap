import { isEngineToWorker } from "../core/engine-messages";
import { PICKER_SELECTION_KEY } from "../core/picker-selection";
import { toAppError } from "../core/errors";
import { isContentToWorker, isPopupToWorker, type ContentToWorker, type JobEvent, type WorkerToPopup } from "../core/messages";
import type { JobRecord } from "../core/jobs/job";
import type { OutputFormat, VideoSource } from "../core/model";
import { parseMaster, parseMedia } from "../core/media/hls";
import { parseMpd } from "../core/media/dash";
import { ENGINE_PORT, parsePopupPortName } from "../platform/ports";
import { alarms, downloads, dnr, offscreen, permissions, runtime, scripting, session, storage, tabs, webRequest } from "../platform/chrome";
import mseHookFile from "../main-world/mse-main?script";
import { lifecycle as lifecycleEvents, manifest } from "../platform/extension";
import { grantedOptionalOrigins, syncMseScripts } from "../platform/mse-scripts";
import { resolveDefaultQuality } from "../core/settings";
import { settingsStore } from "../platform/settings-store";
import { createDownloadOrchestrator } from "./download";
import { createEngineLifecycle } from "./engine-lifecycle";
import { createEngineLink } from "./engine-link";
import { fetchText } from "./fetch-text";
import { createHistoryStore } from "./history";
import { createJobCommands } from "./popup-commands";
import { createJobStore, jobKey } from "./job-store";
import { createMediaService } from "./media-service";
import { createTabRegistry } from "./registry";
import { createSniffer } from "./sniffer";
import { routeContentMessage, routePopupMessage } from "./router";
import { createChromeSnapService, handlePopupSnap, isSnapContentMessage, listenForSnapCommand } from "./snap-wire";

const registry = createTabRegistry(session.area);
const snap = createChromeSnapService(registry);
listenForSnapCommand(snap);

/** Read-only lookup of a saved job's source reference. */
async function resumeRef(jobId: string) {
  const got = await storage.local.get(jobKey(jobId));
  return (got[jobKey(jobId)] as JobRecord | undefined)?.source;
}

/** Leave a video selected for the popup to take when it opens (the in-page picker's hand-off). */
const selectInPopup = (tabId: number, sourceId: string, tab: "list" | "gif") =>
  storage.local.set({ [PICKER_SELECTION_KEY]: { tabId, sourceId, tab } });

const jobStore = createJobStore({ area: storage.local });

const media = createMediaService({
  registry,
  jobs: jobStore,
  sniffer: createSniffer(),
  getTab: (tabId) => tabs.get(tabId).catch(() => undefined),
  scanDom: async (tabId) => {
    const res = await tabs.sendMessage(tabId, { t: "dom/scan" });
    return isContentToWorker(res) && res.t === "dom/report" ? res.sources : undefined;
  },
  adapterContext: {
    fetchText: (url, headers) => fetchText(fetch, url, headers),
    parseMaster,
    parseMedia,
    parseMpd,
  },
});

// ---- downloads -----------------------------------------------------------------

const popupPorts = new Set<chrome.runtime.Port>();
const broadcast = (m: WorkerToPopup) => {
  for (const p of popupPorts) {
    try {
      p.postMessage(m);
    } catch {
      popupPorts.delete(p);
    }
  }
};

const emitJob = (event: JobEvent) => broadcast({ t: "job/event", event });

const lifecycle = createEngineLifecycle({ api: offscreen, url: "src/offscreen/index.html" });
const engineLink = createEngineLink({ ensure: () => lifecycle.ensure() });
const history = createHistoryStore(storage.local);

const orchestrator = createDownloadOrchestrator({
  jobs: jobStore,
  engine: engineLink,
  lifecycle,
  downloads,
  dnr,
  fetch: (url, init) => fetch(url, init),
  parseMedia,
  parseMpd,
  capture: { send: (tabId, frameId, msg) => tabs.sendMessage(tabId, msg, frameId).then(() => undefined) },
  lookupSource: async (tabId, sourceId) => (await registry.list(tabId)).find((s) => s.id === sourceId),
  history,
  emit: emitJob,
  listSources: (tabId) => registry.list(tabId),
  tabUrl: async (tabId) => (await tabs.get(tabId).catch(() => undefined))?.url,
  openTab: async (url) => (await tabs.create({ url, active: true })).id ?? -1,
});

downloads.onChanged.addListener((delta) => orchestrator.onDownloadChanged(delta));

const jobCommands = createJobCommands({
  orchestrator,
  settings: () => settingsStore().get(),
  emit: emitJob,
});

// MSE capture hook: registered at document_start only for sites the user granted at runtime.
async function syncMseHook(): Promise<void> {
  const granted = (await permissions.getAll()).origins ?? [];
  const builtIn = manifest.hostPermissions();
  await syncMseScripts(
    {
      getRegistered: (filter) => scripting.getRegisteredContentScripts(filter),
      register: (s) => scripting.registerContentScripts(s),
      update: (s) => scripting.updateContentScripts(s as chrome.scripting.RegisteredContentScript[]),
      unregister: (filter) => scripting.unregisterContentScripts(filter),
    },
    mseHookFile,
    grantedOptionalOrigins(granted, builtIn),
  );
}
void syncMseHook().catch(() => undefined);
permissions.onAdded.addListener(() => void syncMseHook().catch(() => undefined));
permissions.onRemoved.addListener(() => void syncMseHook().catch(() => undefined));

// ---- startup recovery and daily cleanup (spec 6.6) ------------------------------------

const SWEEP_ALARM = "frame-snap/sweep";
alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SWEEP_ALARM) void orchestrator.sweep().catch(() => undefined);
});
void (async () => {
  await orchestrator.recover();
  await alarms.create(SWEEP_ALARM, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
  await orchestrator.sweep();
})().catch(() => undefined);

// First run: the options page opens with the use notice and privacy summary.
lifecycleEvents.onInstalled((reason) => {
  if (reason === "install") void lifecycleEvents.openOptionsPage().catch(() => undefined);
});

/** Prefer the registry's copy (manifests expanded) over the picker's snapshot. */
async function startPickedDownload(tabId: number, picked: VideoSource, format?: OutputFormat): Promise<void> {
  const source = (await registry.list(tabId)).find((s) => s.id === picked.id) ?? picked;
  const settings = await settingsStore().get();
  await orchestrator.start(
    source,
    {
      format: format ?? settings.defaultFormat,
      quality: resolveDefaultQuality(source, settings.defaultQuality),
      audio: settings.defaultAudio,
      filenameTemplate: settings.filenameTemplate,
    },
    { tabId },
  );
}

webRequest.onHeadersReceived.addListener(
  (d) => {
    void media.onResponse(d).catch(() => undefined);
    return undefined;
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"],
);

tabs.onUpdated.addListener((tabId, info) => {
  // a new top-level load drops everything sniffed on the previous page
  if (info.status === "loading") void media.onNavigated(tabId, 0).catch(() => undefined);
});
tabs.onRemoved.addListener((tabId) => void media.onRemoved(tabId).catch(() => undefined));

runtime.onConnect.addListener((port) => {
  if (port.name === ENGINE_PORT) {
    engineLink.attach(port);
    port.onMessage.addListener((raw: unknown) => {
      if (isEngineToWorker(raw)) void orchestrator.onEngineMessage(raw);
    });
    port.onDisconnect.addListener(() => {
      engineLink.detach(port);
      void orchestrator.onEngineDisconnect();
    });
    return;
  }
  if (parsePopupPortName(port.name) === undefined) return;
  popupPorts.add(port);
  // a GIF that finished while no popup was open is still waiting for Save or Discard
  for (const event of orchestrator.pendingGifs()) port.postMessage({ t: "job/event", event } satisfies WorkerToPopup);
  port.onDisconnect.addListener(() => popupPorts.delete(port));
  port.onMessage.addListener((raw: unknown) => {
    if (!isPopupToWorker(raw)) return;
    if (raw.t === "media/list") {
      void media.openPopup(raw.tabId, (m) => port.postMessage(m)).catch(() => undefined);
      return;
    }
    if (handlePopupSnap(snap, raw)) return;
    if (jobCommands.handle(raw)) return;
    void routePopupMessage(raw, { sendToTab: (tabId, m) => tabs.sendMessage(tabId, m), resumeRef })
      .then((reply) => {
        if (reply) port.postMessage(reply);
      })
      .catch(() => undefined);
  });
});

runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (!isContentToWorker(raw) || sender.tab?.id === undefined) return false;
  const tabId = sender.tab.id;
  const frameId = sender.frameId ?? 0;
  // fire-and-forget reports from the page
  const reports: { [T in ContentToWorker["t"]]?: (m: Extract<ContentToWorker, { t: T }>) => Promise<unknown> } = {
    "dom/report": (m) => media.onDomReport(tabId, frameId, m.sources),
    "capture/progress": (m) => orchestrator.onCaptureMessage(m),
    "capture/result": (m) => orchestrator.onCaptureMessage(m),
    "capture/error": (m) => orchestrator.onCaptureMessage(m),
    "net/tap": (m) => media.onTap(tabId, m.payload),
  };
  const report = reports[raw.t] as ((m: ContentToWorker) => Promise<unknown>) | undefined;
  if (report) {
    void report(raw).catch(() => undefined);
    return false;
  }
  if (raw.t !== "picker/picked" && raw.t !== "picker/action" && !isSnapContentMessage(raw)) return false;
  void routeContentMessage(raw, { tabId, frameId }, {
    resumeRef,
    resumePicked: (jobId, tabId, source) => orchestrator.resumePicked(jobId, tabId, source),
    onPicked: async (tabId, source) => {
      await selectInPopup(tabId, source.id, "list");
    },
    onSnapData: (tabId, msg) => snap.onData(tabId, msg),
    onSnapTainted: (tabId, msg) => snap.onTainted(tabId, msg),
    onAction: async (action, tabId, source, format) => {
      if (action === "snap") return snap.frame(tabId, { source });
      if (action === "download") {
        // a throw would vanish here: show it as a failed job instead
        return startPickedDownload(tabId, source, format).catch((err: unknown) =>
          emitJob({ t: "failed", jobId: crypto.randomUUID(), error: toAppError(err), resumable: false, keptRatio: 0 }),
        );
      }
      if (action !== "gif") return;
      await selectInPopup(tabId, source.id, "gif");
      await lifecycleEvents.openPopup().catch(() => undefined);
    },
  })
    .then((res) => sendResponse(res))
    .catch(() => sendResponse(undefined));
  return true;
});
