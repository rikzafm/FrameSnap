import { isWorkerToContent, type ContentToWorker } from "../core/messages";
import { scanDocument } from "./scan";

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  if (!isWorkerToContent(raw)) return false;
  if (raw.t === "dom/scan") {
    const report: ContentToWorker = { t: "dom/report", sources: scanDocument(document, location.href), frameUrl: location.href };
    sendResponse(report);
    return false;
  }
  const pong: ContentToWorker = { t: "demo/pong", nonce: raw.nonce, reply: `content:${location.hostname}` };
  sendResponse(pong);
  return false;
});
