import { isWorkerToContent, type ContentToWorker } from "../core/messages";
import type { DomDetector } from "./dom-detect";
import type { Picker } from "./picker";

/** Synchronous reply to a service-worker message, or undefined when it is not ours. */
export function handleWorkerMessage(raw: unknown, detector: DomDetector, frameUrl: string, picker?: Picker): ContentToWorker | undefined {
  if (!isWorkerToContent(raw)) return undefined;
  switch (raw.t) {
    case "dom/scan":
      return { t: "dom/report", sources: detector.scan(), frameUrl };
    case "demo/ping":
      return { t: "demo/pong", nonce: raw.nonce, reply: `content:${new URL(frameUrl).hostname}` };
    case "picker/start":
      // Every frame hears this broadcast; only frames that hold a video show a bar.
      if (picker && detector.scan().length > 0) picker.start({ resumeJobId: raw.resumeJobId, resumeTitle: raw.resumeTitle });
      return undefined;
    case "picker/cancel":
      picker?.cancel();
      return undefined;
  }
}
