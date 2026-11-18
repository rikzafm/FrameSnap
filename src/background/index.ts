import { isContentToWorker, isPopupToWorker } from "../core/messages";
import { parseMaster, parseMedia } from "../core/media/hls";
import { parseMpd } from "../core/media/dash";
import { parsePopupPortName } from "../platform/ports";
import { runtime, session, tabs, webRequest } from "../platform/chrome";
import { createMediaService } from "./media-service";
import { createTabRegistry } from "./registry";
import { createSniffer } from "./sniffer";
import { routePopupMessage } from "./router";

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
    void routePopupMessage(raw, { sendToTab: (tabId, m) => tabs.sendMessage(tabId, m) })
      .then((reply) => {
        if (reply) port.postMessage(reply);
      })
      .catch(() => undefined);
  });
});
