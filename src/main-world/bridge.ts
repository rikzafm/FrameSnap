/**
 * Isolated-world half of the network tap (document_start on x.com / twitter.com).
 * Hands the main-world tap a random nonce, then forwards nonce-checked payloads
 * to the service worker.
 */
import type { ContentToWorker } from "../core/messages";
import { createTapReceiver, TAP_INIT_CHANNEL } from "./protocol";

const nonce = crypto.randomUUID();

window.addEventListener(
  "message",
  createTapReceiver({
    nonce,
    window,
    origin: location.origin,
    onPayload: (payload) => {
      const msg: ContentToWorker = { t: "net/tap", payload, frameUrl: location.href };
      chrome.runtime.sendMessage(msg).catch(() => {});
    },
  }),
);

window.postMessage({ channel: TAP_INIT_CHANNEL, nonce }, location.origin);
