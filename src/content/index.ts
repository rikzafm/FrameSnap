import type { ContentToWorker } from "../core/messages";
import { createDomDetector } from "./dom-detect";
import { handleWorkerMessage } from "./handler";

const frameUrl = location.href;

const detector = createDomDetector({
  document,
  frameUrl,
  emit: (sources) => {
    const msg: ContentToWorker = { t: "dom/report", sources, frameUrl };
    chrome.runtime.sendMessage(msg).catch(() => {});
  },
});
detector.start();

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const reply = handleWorkerMessage(raw, detector, frameUrl);
  if (!reply) return false;
  sendResponse(reply);
  return false;
});
