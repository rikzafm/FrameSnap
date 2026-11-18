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
  | { t: "snap/frame"; tabId: number; sourceId?: string }
  | { t: "demo/ping"; tabId: number; nonce: string };

export type WorkerToPopup =
  | { t: "media/updated"; tabId: number; sources: VideoSource[]; selectedId?: string }
  | { t: "job/event"; event: JobEvent }
  | { t: "demo/pong"; nonce: string; reply: string };

export type JobEvent =
  | { t: "queued"; jobId: string }
  | { t: "progress"; jobId: string; phase: JobPhase; ratio: number; bytes?: number }
  | { t: "done"; jobId: string; downloadId: number; filename: string }
  | { t: "failed"; jobId: string; error: AppError; resumable: boolean; keptRatio: number }
  | { t: "cancelled"; jobId: string }
  | { t: "resume-needs-pick"; jobId: string };

/** Service worker to a tab's content script (tabs.sendMessage). */
export type WorkerToContent = { t: "demo/ping"; nonce: string } | { t: "dom/scan" };

export type ContentToWorker =
  | { t: "dom/report"; sources: VideoSource[]; frameUrl: string }
  | { t: "picker/picked"; source: VideoSource; resumeJobId?: string }
  | { t: "snap/data"; dataUrl: string; width: number; height: number; time: number; title: string }
  | { t: "demo/pong"; nonce: string; reply: string };

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const str = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const PHASES = new Set<string>(["fetch", "engine", "save"]);

/** Loose structural check: enough to stop a malformed source crashing a receiver. */
function isVideoSource(x: unknown): x is VideoSource {
  return isObj(x) && str(x.id) && typeof x.title === "string" && Array.isArray(x.variants) && Array.isArray(x.audioTracks);
}
const isSources = (x: unknown): x is VideoSource[] => Array.isArray(x) && x.every(isVideoSource);

export function isPopupToWorker(x: unknown): x is PopupToWorker {
  if (!isObj(x) || typeof x.t !== "string") return false;
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
    case "demo/ping":
      return num(x.tabId) && str(x.nonce);
    default:
      return false;
  }
}

export function isJobEvent(x: unknown): x is JobEvent {
  if (!isObj(x) || typeof x.t !== "string" || !str(x.jobId)) return false;
  switch (x.t) {
    case "queued":
    case "cancelled":
    case "resume-needs-pick":
      return true;
    case "progress":
      return typeof x.phase === "string" && PHASES.has(x.phase) && num(x.ratio) && (x.bytes === undefined || num(x.bytes));
    case "done":
      return num(x.downloadId) && str(x.filename);
    case "failed":
      return isObj(x.error) && typeof x.resumable === "boolean" && num(x.keptRatio);
    default:
      return false;
  }
}

export function isWorkerToPopup(x: unknown): x is WorkerToPopup {
  if (!isObj(x) || typeof x.t !== "string") return false;
  switch (x.t) {
    case "media/updated":
      return num(x.tabId) && isSources(x.sources) && (x.selectedId === undefined || str(x.selectedId));
    case "job/event":
      return isJobEvent(x.event);
    case "demo/pong":
      return str(x.nonce) && typeof x.reply === "string";
    default:
      return false;
  }
}

export function isWorkerToContent(x: unknown): x is WorkerToContent {
  if (!isObj(x)) return false;
  return x.t === "dom/scan" || (x.t === "demo/ping" && str(x.nonce));
}

export function isContentToWorker(x: unknown): x is ContentToWorker {
  if (!isObj(x) || typeof x.t !== "string") return false;
  switch (x.t) {
    case "dom/report":
      return isSources(x.sources) && str(x.frameUrl);
    case "picker/picked":
      return isVideoSource(x.source) && (x.resumeJobId === undefined || str(x.resumeJobId));
    case "snap/data":
      return typeof x.dataUrl === "string" && num(x.width) && num(x.height) && num(x.time) && typeof x.title === "string";
    case "demo/pong":
      return str(x.nonce) && typeof x.reply === "string";
    default:
      return false;
  }
}
