import { isWorkerToContent, type ContentToWorker } from "../core/messages";
import type { DomDetector } from "./dom-detect";

/** Synchronous reply to a service-worker message, or undefined when it is not ours. */
export function handleWorkerMessage(raw: unknown, detector: DomDetector, frameUrl: string): ContentToWorker | undefined {
  if (!isWorkerToContent(raw)) return undefined;
  switch (raw.t) {
    case "dom/scan":
      return { t: "dom/report", sources: detector.scan(), frameUrl };
    case "demo/ping":
      return { t: "demo/pong", nonce: raw.nonce, reply: `content:${new URL(frameUrl).hostname}` };
  }
}
