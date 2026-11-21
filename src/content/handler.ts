import { isWorkerToContent, type ContentToWorker } from "../core/messages";
import type { VideoSource } from "../core/model";
import type { DomDetector } from "./dom-detect";
import type { Picker } from "./picker";
import type { Snapper } from "./snap";

/** Synchronous reply to a service-worker message, or undefined when it is not ours. */
const frameUrlOf = (u: string | (() => string)): string => (typeof u === "function" ? u() : u);

export function handleWorkerMessage(
  raw: unknown,
  detector: DomDetector,
  frameUrlOrGet: string | (() => string),
  picker?: Picker,
  snapper?: Snapper,
  getContextTarget?: () => VideoSource | undefined,
): ContentToWorker | undefined {
  if (!isWorkerToContent(raw)) return undefined;
  switch (raw.t) {
    case "dom/scan":
      return { t: "dom/report", sources: detector.scan(), frameUrl: frameUrlOf(frameUrlOrGet) };
    case "context/target":
      return { t: "context/target-report", source: getContextTarget?.() };
    case "demo/ping":
      return { t: "demo/pong", nonce: raw.nonce, reply: `content:${new URL(frameUrlOf(frameUrlOrGet)).hostname}` };
    case "picker/start":
      // Every frame hears this broadcast; only frames that hold a video show a bar.
      if (picker && detector.scan().length > 0) picker.start({ resumeJobId: raw.resumeJobId, resumeTitle: raw.resumeTitle });
      return undefined;
    case "picker/cancel":
      picker?.cancel();
      return undefined;
    // Snap messages are broadcast to every frame; a frame with no video ignores them.
    case "snap/capture":
      void snapper?.capture({ ...(raw.elementKey ? { elementKey: raw.elementKey } : {}), options: raw.options }).catch(() => undefined);
      return undefined;
    case "snap/step":
      snapper?.step(raw.dir, raw.elementKey);
      return undefined;
    case "snap/seek":
      snapper?.seek(raw.time, raw.elementKey);
      return undefined;
    case "snap/burst":
      snapper?.burst({ ...(raw.elementKey ? { elementKey: raw.elementKey } : {}), intervalSec: raw.intervalSec, options: raw.options });
      return undefined;
    case "snap/burst-stop":
      snapper?.stopBurst();
      return undefined;
    case "snap/result":
      snapper?.toast(raw.text);
      return undefined;
  }
}
