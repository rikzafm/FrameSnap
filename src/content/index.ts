import { isWorkerToContent, type ContentToWorker } from "../core/messages";

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  if (!isWorkerToContent(raw)) return false;
  const pong: ContentToWorker = { t: "demo/pong", nonce: raw.nonce, reply: `content:${location.hostname}` };
  sendResponse(pong);
  return false;
});
