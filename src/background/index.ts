import { isEngineToWorker } from "../core/engine-messages";
import { isContentToWorker, isPopupToWorker, type WorkerToPopup } from "../core/messages";
import type { JobRecord } from "../core/jobs/job";
import type { DownloadOptions, VideoSource } from "../core/model";
import { parseMaster, parseMedia } from "../core/media/hls";
import { parseMpd } from "../core/media/dash";
import { ENGINE_PORT, parsePopupPortName } from "../platform/ports";
import { downloads, dnr, offscreen, permissions, runtime, scripting, session, storage, tabs, webRequest } from "../platform/chrome";
import mseHookFile from "../main-world/mse-main?script";
import { grantedOptionalOrigins, syncMseScripts } from "../platform/mse-scripts";
import { resolveDefaultQuality } from "../core/settings";
import { settingsStore } from "../platform/settings-store";
import { createDownloadOrchestrator } from "./download";
import { createEngineLifecycle } from "./engine-lifecycle";
import { createEngineLink } from "./engine-link";
import { createHistoryStore } from "./history";
import { createJobStore, jobKey } from "./job-store";
import { createMediaService } from "./media-service";
import { createTabRegistry } from "./registry";
import { createSniffer } from "./sniffer";
import { routeContentMessage, routePopupMessage } from "./router";
import { createChromeSnapService, handlePopupSnap, isSnapContentMessage, listenForSnapCommand } from "./snap-wire";

const snap = createChromeSnapService(createTabRegistry(session.area));
listenForSnapCommand(snap);

/** Read-only lookup of a saved job's source reference. */
async function resumeRef(jobId: string) {
  const got = await storage.local.get(jobKey(jobId));
  return (got[jobKey(jobId)] as JobRecord | undefined)?.source;
}

/** Key the popup reads on open: which tab and source the picker asked for. */
export const PICKER_SELECTION_KEY = "pickerSelection";

const registry = createTabRegistry(session.area);

const media = createMediaService({
  registry,
  sniffer: createSniffer(),
  getTab: (tabId) => tabs.get(tabId).catch(() => undefined),
  scanDom: async (tabId) => {
    const res = await tabs.sendMessage(tabId, { t: "dom/scan" });
    return isContentToWorker(res) && res.t === "dom/report" ? res.sources : undefined;
  },
  adapterContext: {
    fetchText: async (url, headers) => {
      const res = await fetch(url, headers ? { headers } : undefined);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    },
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

const lifecycle = createEngineLifecycle({ api: offscreen, url: "src/offscreen/index.html" });
const engineLink = createEngineLink({ ensure: () => lifecycle.ensure() });
const history = createHistoryStore(storage.local);

const orchestrator = createDownloadOrchestrator({
  jobs: createJobStore({ area: storage.local }),
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
  emit: (event) => broadcast({ t: "job/event", event }),
});

downloads.onChanged.addListener((delta) => orchestrator.onDownloadChanged(delta));

// MSE capture hook: registered at document_start only for sites the user granted at runtime.
async function syncMseHook(): Promise<void> {
  const granted = (await permissions.getAll()).origins ?? [];
  const builtIn = chrome.runtime.getManifest().host_permissions ?? [];
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

// First run: the options page opens with the use notice and privacy summary.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") void chrome.runtime.openOptionsPage().catch(() => undefined);
});

/** Prefer the registry's copy (manifests expanded) over the picker's snapshot. */
async function startPickedDownload(tabId: number, picked: VideoSource): Promise<void> {
  const source = (await registry.list(tabId)).find((s) => s.id === picked.id) ?? picked;
  const settings = await settingsStore().get();
  await orchestrator.start(
    source,
    { format: settings.defaultFormat, quality: resolveDefaultQuality(source, settings.defaultQuality), audio: settings.defaultAudio, filenameTemplate: settings.filenameTemplate },
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
  port.onDisconnect.addListener(() => popupPorts.delete(port));
  port.onMessage.addListener((raw: unknown) => {
    if (!isPopupToWorker(raw)) return;
    if (raw.t === "media/list") {
      void media.openPopup(raw.tabId, (m) => port.postMessage(m)).catch(() => undefined);
      return;
    }
    if (handlePopupSnap(snap, raw)) return;
    if (raw.t === "job/download") {
      void orchestrator.download({ tabId: raw.tabId, sourceId: raw.sourceId, options: raw.options as DownloadOptions }).catch(() => undefined);
      return;
    }
    if (raw.t === "job/cancel") {
      void orchestrator.cancel(raw.jobId).catch(() => undefined);
      return;
    }
    void routePopupMessage(raw, { sendToTab: (tabId, m) => tabs.sendMessage(tabId, m), resumeRef })
      .then((reply) => {
        if (reply) port.postMessage(reply);
      })
      .catch(() => undefined);
  });
});

runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (!isContentToWorker(raw) || sender.tab?.id === undefined) return false;
  if (raw.t === "dom/report") {
    void media.onDomReport(sender.tab.id, sender.frameId ?? 0, raw.sources).catch(() => undefined);
    return false;
  }
  if (raw.t === "capture/progress" || raw.t === "capture/result" || raw.t === "capture/error") {
    void orchestrator.onCaptureMessage(raw).catch(() => undefined);
    return false;
  }
  if (raw.t === "net/tap") {
    void media.onTap(sender.tab.id, raw.payload).catch(() => undefined);
    return false;
  }
  if (raw.t !== "picker/picked" && raw.t !== "picker/action" && !isSnapContentMessage(raw)) return false;
  const from = { tabId: sender.tab.id, frameId: sender.frameId ?? 0 };
  void routeContentMessage(raw, from, {
    resumeRef,
    // The resume flow (ticket 12) picks the job back up from here.
    resumePicked: async () => undefined,
    onPicked: async (tabId, source) => {
      await storage.local.set({ [PICKER_SELECTION_KEY]: { tabId, sourceId: source.id, tab: "list" } });
    },
    onSnapData: (tabId, msg) => snap.onData(tabId, msg),
    onSnapTainted: (tabId, msg) => snap.onTainted(tabId, msg),
    onAction: async (action, tabId, source) => {
      if (action === "snap") return snap.frame(tabId, { source });
      if (action === "download") return startPickedDownload(tabId, source);
      if (action !== "gif") return;
      await storage.local.set({ [PICKER_SELECTION_KEY]: { tabId, sourceId: source.id, tab: "gif" } });
      await chrome.action.openPopup().catch(() => undefined);
    },
  })
    .then((res) => sendResponse(res))
    .catch(() => sendResponse(undefined));
  return true;
});
