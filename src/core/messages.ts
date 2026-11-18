/**
 * Typed messages between popup, service worker, content script and offscreen
 * document. Every receiver runs the guard before trusting a payload.
 */
import type { AppError } from "./errors";
import type { JobPhase } from "./jobs/job";
import type { DownloadOptions, GifOptions, VideoSource } from "./model";

export type PopupToWorker =
  | { t: "media/list"; tabId: number }
  | { t: "job/download"; tabId: number; sourceId: string; options: DownloadOptions }
  | { t: "job/gif"; tabId: number; sourceId: string; options: GifOptions }
  | { t: "job/cancel"; jobId: string }
  | { t: "job/resume"; jobId: string; tabId: number }
  | { t: "job/discard"; jobId: string }
  | { t: "picker/start"; tabId: number; resumeJobId?: string }
  | { t: "snap/frame"; tabId: number; sourceId?: string };

export type WorkerToPopup =
  | { t: "media/updated"; tabId: number; sources: VideoSource[]; selectedId?: string }
  | { t: "job/event"; event: JobEvent };

export type JobEvent =
  | { t: "queued"; jobId: string }
  | { t: "progress"; jobId: string; phase: JobPhase; ratio: number; bytes?: number }
  | { t: "done"; jobId: string; downloadId: number; filename: string }
  | { t: "failed"; jobId: string; error: AppError; resumable: boolean; keptRatio: number }
  | { t: "cancelled"; jobId: string }
  | { t: "resume-needs-pick"; jobId: string };

export type ContentToWorker =
  | { t: "dom/report"; sources: VideoSource[]; frameUrl: string }
  | { t: "picker/picked"; source: VideoSource; resumeJobId?: string }
  | { t: "snap/data"; dataUrl: string; width: number; height: number; time: number; title: string };

const POPUP_TYPES = new Set<string>([
  "media/list",
  "job/download",
  "job/gif",
  "job/cancel",
  "job/resume",
  "job/discard",
  "picker/start",
  "snap/frame",
]);

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const str = (x: unknown): x is string => typeof x === "string" && x.length > 0;

export function isPopupToWorker(x: unknown): x is PopupToWorker {
  if (!isObj(x) || typeof x.t !== "string" || !POPUP_TYPES.has(x.t)) return false;
  switch (x.t) {
    case "media/list":
      return num(x.tabId);
    case "job/download":
    case "job/gif":
      return num(x.tabId) && str(x.sourceId) && isObj(x.options);
    case "job/cancel":
    case "job/discard":
      return str(x.jobId);
    case "job/resume":
      return str(x.jobId) && num(x.tabId);
    case "picker/start":
      return num(x.tabId) && (x.resumeJobId === undefined || str(x.resumeJobId));
    case "snap/frame":
      return num(x.tabId) && (x.sourceId === undefined || str(x.sourceId));
    default:
      return false;
  }
}
