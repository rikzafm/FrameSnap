import type { ContentToWorker } from "../core/messages";
import { createDomDetector } from "./dom-detect";
import { handleWorkerMessage } from "./handler";
import { createPicker } from "./picker";
import { createSnapper } from "./snap";
import { createSnapButton, createSnapUi } from "./snap-ui";
import { SNAP_PREFS_KEY, normalizeSnapOptions } from "../core/snap";

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
chrome.storage.local
  .get(SNAP_PREFS_KEY)
  .then((got) => applyPrefs(got[SNAP_PREFS_KEY]))
  .catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[SNAP_PREFS_KEY]) applyPrefs(changes[SNAP_PREFS_KEY].newValue);
});

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const reply = handleWorkerMessage(raw, detector, frameUrl, picker, snapper);
  if (!reply) return false;
  sendResponse(reply);
  return false;
});
