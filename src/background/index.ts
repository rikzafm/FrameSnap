import { isContentToWorker, isPopupToWorker } from "../core/messages";
import type { JobRecord } from "../core/jobs/job";
import { parseMaster, parseMedia } from "../core/media/hls";
import { parseMpd } from "../core/media/dash";
import { parsePopupPortName } from "../platform/ports";
import { runtime, session, storage, tabs, webRequest } from "../platform/chrome";
import { jobKey } from "./job-store";
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

const media = createMediaService({
  registry: createTabRegistry(session.area),
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
  if (parsePopupPortName(port.name) === undefined) return;
  port.onMessage.addListener((raw: unknown) => {
    if (!isPopupToWorker(raw)) return;
    if (raw.t === "media/list") {
      void media.openPopup(raw.tabId, (m) => port.postMessage(m)).catch(() => undefined);
      return;
    }
    if (handlePopupSnap(snap, raw)) return;
    void routePopupMessage(raw, { sendToTab: (tabId, m) => tabs.sendMessage(tabId, m), resumeRef })
      .then((reply) => {
        if (reply) port.postMessage(reply);
      })
      .catch(() => undefined);
  });
});

runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (!isContentToWorker(raw) || (raw.t !== "picker/picked" && raw.t !== "picker/action" && !isSnapContentMessage(raw)) || sender.tab?.id === undefined) return false;
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
      if (action !== "gif") return; // download is wired by its own ticket
      await storage.local.set({ [PICKER_SELECTION_KEY]: { tabId, sourceId: source.id, tab: "gif" } });
      await chrome.action.openPopup().catch(() => undefined);
    },
  })
    .then((res) => sendResponse(res))
    .catch(() => sendResponse(undefined));
  return true;
});
