import type { ContentToWorker } from "../core/messages";
import { createDomDetector } from "./dom-detect";
import { handleWorkerMessage } from "./handler";
import { createPicker } from "./picker";

const frameUrl = location.href;

const send = (msg: ContentToWorker) => {
  chrome.runtime.sendMessage(msg).catch(() => {});
};

const detector = createDomDetector({
  document,
  frameUrl,
  emit: (sources) => send({ t: "dom/report", sources, frameUrl }),
});
detector.start();

const picker = createPicker({ document, detector, send });

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const reply = handleWorkerMessage(raw, detector, frameUrl, picker);
  if (!reply) return false;
  sendResponse(reply);
  return false;
});
