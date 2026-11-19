/**
 * Typed messages between popup, service worker, content script and offscreen
 * document. Every receiver runs the guard before trusting a payload.
 */
import type { AppError } from "./errors";
import type { JobPhase, JobRecord } from "./jobs/job";
import type { DownloadOptions, GifOptions, OutputFormat, VideoSource } from "./model";
import type { Rect, SnapFormat, SnapOptions } from "./snap";

export type PopupToWorker =
  | { t: "media/list"; tabId: number }
  | { t: "job/download"; tabId: number; sourceId: string; options: DownloadOptions }
  | { t: "job/gif"; tabId: number; sourceId: string; options: GifOptions }
  | { t: "job/cancel"; jobId: string }
  /** Save the previewed GIF. Discarding it is `job/cancel`. */
  | { t: "job/save"; jobId: string }
  | { t: "job/resume"; jobId: string; tabId: number }
  | { t: "job/discard"; jobId: string }
  | { t: "picker/start"; tabId: number; resumeJobId?: string }
  | { t: "snap/frame"; tabId: number; sourceId?: string; options?: SnapOptions }
  | { t: "snap/step"; tabId: number; dir: 1 | -1; sourceId?: string }
  /** Show `time` (seconds) in the page video: the GIF trim preview. */
  | { t: "snap/seek"; tabId: number; time: number; sourceId?: string }
  | { t: "snap/burst"; tabId: number; sourceId?: string; intervalSec: number; options?: SnapOptions }
  | { t: "snap/burst-stop"; tabId: number }
  | { t: "demo/ping"; tabId: number; nonce: string };

export type WorkerToPopup =
  | { t: "media/updated"; tabId: number; sources: VideoSource[]; selectedId?: string; /** Failed jobs resumable on this page (banner). */ resumable?: JobRecord[] }
  | { t: "job/event"; event: JobEvent }
  | { t: "demo/pong"; nonce: string; reply: string };

export type JobEvent =
  | { t: "queued"; jobId: string }
  | { t: "progress"; jobId: string; phase: JobPhase; ratio: number; bytes?: number; totalBytes?: number }
  | { t: "done"; jobId: string; downloadId: number; filename: string }
  | { t: "failed"; jobId: string; error: AppError; resumable: boolean; keptRatio: number }
  | { t: "cancelled"; jobId: string }
  /** A GIF is rendered and waits for Save or Discard; `url` is a blob: URL the popup can preview. */
  | { t: "gif-ready"; jobId: string; url: string; bytes: number; filename: string; title: string }
  | { t: "resume-needs-pick"; jobId: string }
  /** A resume started over because the video changed (error copy `changed`). */
  | { t: "notice"; jobId: string; code: "changed" };

/** Service worker to a tab's content script (tabs.sendMessage). */
export type WorkerToContent =
  | { t: "demo/ping"; nonce: string }
  | { t: "dom/scan" }
  | { t: "picker/start"; resumeJobId?: string; resumeTitle?: string }
  | { t: "picker/cancel" }
  /** Snap the frame on screen; `elementKey` picks the video, else the best one in the frame. */
  | { t: "snap/capture"; elementKey?: string; options: SnapOptions }
  | { t: "snap/step"; dir: 1 | -1; elementKey?: string }
  | { t: "snap/seek"; time: number; elementKey?: string }
  | { t: "snap/burst"; elementKey?: string; intervalSec: number; options: SnapOptions }
  | { t: "snap/burst-stop" }
  /** Outcome to show as a toast. */
  | { t: "snap/result"; kind: "saved" | "tainted" | "error"; text: string }
  /** Capture route (blob: sources). Sent to one frame. `durationSec` bounds a recorder capture. */
  | { t: "capture/start"; jobId: string; kind: CaptureKind; elementKey: string; streamId?: string; durationSec?: number }
  | { t: "capture/cancel"; jobId: string }
  /** The saved file's blob: URL can be freed. */
  | { t: "capture/revoke"; url: string };

export type CaptureKind = "mse-capture" | "recorder";

export const PICKER_FORMATS: readonly string[] = ["mp4", "webm", "mkv", "mov", "mp3", "m4a"];
export type PickerAction = "download" | "gif" | "snap";

export type ContentToWorker =
  | { t: "dom/report"; sources: VideoSource[]; frameUrl: string }
  | { t: "picker/picked"; source: VideoSource; resumeJobId?: string }
  | { t: "picker/action"; action: PickerAction; source: VideoSource; /** Download only: the format picked from the action bar menu. */ format?: OutputFormat }
  | { t: "snap/data"; dataUrl: string; width: number; height: number; time: number; title: string; site?: string; format?: SnapFormat }
  /** The frame could not be read: ask the worker for a cropped tab capture instead. */
  | { t: "snap/tainted"; rect: Rect; dpr: number; time: number; title: string; site?: string; format: SnapFormat; quality: number }
  | { t: "demo/pong"; nonce: string; reply: string }
  /** JSON captured by the main-world network tap (X GraphQL). */
  | { t: "net/tap"; payload: unknown; frameUrl: string }
  | { t: "capture/progress"; jobId: string; ratio: number }
  | { t: "capture/result"; jobId: string; url: string; bytes: number; mime: string; container: "mp4" | "webm"; hasAudio: boolean }
  | { t: "capture/error"; jobId: string; error: AppError };

export type CaptureEvent = Extract<ContentToWorker, { t: "capture/progress" | "capture/result" | "capture/error" }>;

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const str = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const isDir = (x: unknown): x is 1 | -1 => x === 1 || x === -1;
const isSnapOptions = (x: unknown): x is SnapOptions =>
  isObj(x) && (x.format === "png" || x.format === "jpeg" || x.format === "webp") && num(x.quality) && typeof x.copy === "boolean" && typeof x.showButton === "boolean";
const isRect = (x: unknown): x is Rect => isObj(x) && num(x.x) && num(x.y) && num(x.width) && num(x.height);
const isGifOptions = (x: unknown): x is GifOptions =>
  isObj(x) &&
  isObj(x.trim) &&
  num(x.trim.start) &&
  num(x.trim.end) &&
  x.trim.end > x.trim.start &&
  (x.fps === 10 || x.fps === 15 || x.fps === 24 || x.fps === 30 || x.fps === "source") &&
  (x.width === 320 || x.width === 480 || x.width === 640 || x.width === "original") &&
  num(x.loop) &&
  typeof x.dither === "boolean";
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
      return num(x.tabId) && str(x.sourceId) && isObj(x.options);
    case "job/gif":
      return num(x.tabId) && str(x.sourceId) && isGifOptions(x.options);
    case "job/cancel":
    case "job/discard":
    case "job/save":
      return str(x.jobId);
    case "job/resume":
      return str(x.jobId) && num(x.tabId);
    case "picker/start":
      return num(x.tabId) && (x.resumeJobId === undefined || str(x.resumeJobId));
    case "snap/frame":
      return num(x.tabId) && (x.sourceId === undefined || str(x.sourceId)) && (x.options === undefined || isSnapOptions(x.options));
    case "snap/step":
      return num(x.tabId) && isDir(x.dir) && (x.sourceId === undefined || str(x.sourceId));
    case "snap/seek":
      return num(x.tabId) && num(x.time) && x.time >= 0 && (x.sourceId === undefined || str(x.sourceId));
    case "snap/burst":
      return num(x.tabId) && num(x.intervalSec) && (x.sourceId === undefined || str(x.sourceId)) && (x.options === undefined || isSnapOptions(x.options));
    case "snap/burst-stop":
      return num(x.tabId);
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
    case "notice":
      return x.code === "changed";
    case "progress":
      return typeof x.phase === "string" && PHASES.has(x.phase) && num(x.ratio) && (x.bytes === undefined || num(x.bytes)) && (x.totalBytes === undefined || num(x.totalBytes));
    case "done":
      return num(x.downloadId) && str(x.filename);
    case "gif-ready":
      return str(x.url) && num(x.bytes) && str(x.filename) && typeof x.title === "string";
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
      return num(x.tabId) && isSources(x.sources) && (x.selectedId === undefined || str(x.selectedId)) && (x.resumable === undefined || (Array.isArray(x.resumable) && x.resumable.every((j) => isObj(j) && str(j.id))));
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
  switch (x.t) {
    case "dom/scan":
    case "picker/cancel":
    case "snap/burst-stop":
      return true;
    case "snap/capture":
      return isSnapOptions(x.options) && (x.elementKey === undefined || typeof x.elementKey === "string");
    case "snap/step":
      return isDir(x.dir) && (x.elementKey === undefined || typeof x.elementKey === "string");
    case "snap/seek":
      return num(x.time) && x.time >= 0 && (x.elementKey === undefined || typeof x.elementKey === "string");
    case "snap/burst":
      return num(x.intervalSec) && isSnapOptions(x.options) && (x.elementKey === undefined || typeof x.elementKey === "string");
    case "snap/result":
      return (x.kind === "saved" || x.kind === "tainted" || x.kind === "error") && typeof x.text === "string";
    case "demo/ping":
      return str(x.nonce);
    case "capture/start":
      return (
        str(x.jobId) &&
        (x.kind === "mse-capture" || x.kind === "recorder") &&
        str(x.elementKey) &&
        (x.streamId === undefined || str(x.streamId)) &&
        (x.durationSec === undefined || num(x.durationSec))
      );
    case "capture/cancel":
      return str(x.jobId);
    case "capture/revoke":
      return str(x.url);
    case "picker/start":
      return (x.resumeJobId === undefined || str(x.resumeJobId)) && (x.resumeTitle === undefined || typeof x.resumeTitle === "string");
    default:
      return false;
  }
}

export function isContentToWorker(x: unknown): x is ContentToWorker {
  if (!isObj(x) || typeof x.t !== "string") return false;
  switch (x.t) {
    case "dom/report":
      return isSources(x.sources) && str(x.frameUrl);
    case "picker/picked":
      return isVideoSource(x.source) && (x.resumeJobId === undefined || str(x.resumeJobId));
    case "picker/action":
      return (x.action === "download" || x.action === "gif" || x.action === "snap") && isVideoSource(x.source) && (x.format === undefined || (typeof x.format === "string" && PICKER_FORMATS.includes(x.format)));
    case "snap/data":
      return typeof x.dataUrl === "string" && num(x.width) && num(x.height) && num(x.time) && typeof x.title === "string";
    case "snap/tainted":
      return isRect(x.rect) && num(x.dpr) && num(x.time) && typeof x.title === "string" && (x.format === "png" || x.format === "jpeg" || x.format === "webp") && num(x.quality);
    case "net/tap":
      return isObj(x.payload) && str(x.frameUrl);
    case "capture/progress":
      return str(x.jobId) && num(x.ratio);
    case "capture/result":
      return str(x.jobId) && str(x.url) && num(x.bytes) && typeof x.mime === "string" && (x.container === "mp4" || x.container === "webm") && typeof x.hasAudio === "boolean";
    case "capture/error":
      return str(x.jobId) && isObj(x.error) && typeof x.error.code === "string";
    case "demo/pong":
      return str(x.nonce) && typeof x.reply === "string";
    default:
      return false;
  }
}
