import { isWorkerToContent, type ContentToWorker } from "../core/messages";
import { createMseClient } from "../main-world/mse-protocol";
import { blobVariants, createCaptureRunner } from "./capture";
import { createDomDetector } from "./dom-detect";
import { handleWorkerMessage } from "./handler";
import { createPicker } from "./picker";
import { createSnapper } from "./snap";
import { createSnapButton, createSnapUi } from "./snap-ui";
import { SNAP_PREFS_KEY, normalizeSnapOptions } from "../core/snap";
import { localSettings, messaging } from "../platform/extension";

const frameUrl = location.href;

const send = (msg: ContentToWorker) => messaging.send(msg);

// MSE capture: the main-world hook (registered only on granted sites) reports streams over a nonce-checked channel.
const mse = createMseClient(window, crypto.randomUUID());
const canRecord = typeof HTMLMediaElement !== "undefined" && "captureStream" in HTMLMediaElement.prototype && typeof MediaRecorder !== "undefined";

const detector = createDomDetector({
  document,
  frameUrl,
  emit: (sources) => send({ t: "dom/report", sources, frameUrl }),
  blobVariants: (video, src, elementKey) => blobVariants(video, src, elementKey, mse.byUrl(src), canRecord),
});
mse.onChange(() => detector.refresh());
detector.start();

const captures = createCaptureRunner({
  detector,
  mse,
  send,
  urls: { create: (b) => URL.createObjectURL(b), revoke: (u) => URL.revokeObjectURL(u) },
});

const picker = createPicker({ document, detector, send });

const snapper = createSnapper({ document, detector, send, ui: createSnapUi({ document }) });
let snapPrefs = normalizeSnapOptions(undefined);
const snapButton = createSnapButton({
  document,
  detector,
  enabled: snapPrefs.showButton,
  onSnap: (elementKey) => void snapper.capture({ elementKey, options: snapPrefs }).catch(() => undefined),
});
const applyPrefs = (raw: unknown) => {
  snapPrefs = normalizeSnapOptions(raw);
  snapButton.setEnabled(snapPrefs.showButton);
};
localSettings
  .get(SNAP_PREFS_KEY)
  .then(applyPrefs)
  .catch(() => {});
localSettings.watch(SNAP_PREFS_KEY, applyPrefs);

messaging.onMessage((raw: unknown, _sender, sendResponse) => {
  if (isWorkerToContent(raw) && (raw.t === "capture/start" || raw.t === "capture/cancel" || raw.t === "capture/revoke")) {
    void captures.handle(raw);
    return false;
  }
  const reply = handleWorkerMessage(raw, detector, frameUrl, picker, snapper);
  if (!reply) return false;
  sendResponse(reply);
  return false;
});
