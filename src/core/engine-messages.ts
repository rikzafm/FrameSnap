/**
 * Messages on the "engine" port between the service worker and the offscreen
 * document. The service worker owns job records; the offscreen document owns
 * bytes (chunk store, ffmpeg) and only reports what happened.
 */
import type { AppError } from "./errors";
import type { TrackPlan } from "./jobs/chunks";
import type { TrackValidators } from "./jobs/source-ref";
import type { Seek } from "./ffmpeg-args";
import type { GifOptions } from "./model";
import type { DownloadPlan } from "./plan";

/** One track's chunks in plan order, to be concatenated into an engine input. */
export interface EngineTrackRef {
  trackId: string;
  keys: string[];
}

export type WorkerToEngine =
  /** Fetch every missing chunk into the store (resumable). */
  | { t: "engine/fetch"; jobId: string; tracks: TrackPlan[]; headers?: Record<string, string>; validators?: Record<string, TrackValidators> }
  /** Assemble the fetched tracks and run the download command line. */
  | { t: "engine/download"; jobId: string; plan: DownloadPlan; tracks: EngineTrackRef[]; seeks: (Seek | undefined)[] }
  /** Assemble one track and render a GIF in two passes. */
  | { t: "engine/gif"; jobId: string; options: GifOptions; src: { width: number; height: number }; track: EngineTrackRef & { container: string }; seek: Seek }
  | { t: "engine/cancel"; jobId: string }
  /** Drop the job's chunks (also forgets a memory-fallback store). */
  | { t: "engine/discard"; jobId: string }
  /** The file is saved: free the blob: URL. */
  | { t: "engine/revoke"; url: string }
  | { t: "engine/storage" };

export interface StorageReport {
  usage: number;
  quota: number;
  persisted: boolean;
}

export type EngineToWorker =
  /** Sent on connect and after `engine/storage`. */
  | { t: "engine/ready"; storage: StorageReport }
  | { t: "engine/commit"; jobId: string; trackId: string; key: string; bytes: number }
  | { t: "engine/progress"; jobId: string; phase: "fetch" | "engine"; ratio: number }
  /** Fetch phase finished. `resumable: false` = the store fell back to memory. */
  | { t: "engine/fetched"; jobId: string; resumable: boolean }
  | { t: "engine/result"; jobId: string; url: string; bytes: number; mime: string }
  | { t: "engine/error"; jobId: string; error: AppError; resumable: boolean };

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}
const str = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isRef = (x: unknown): x is EngineTrackRef => isObj(x) && str(x.trackId) && Array.isArray(x.keys) && x.keys.every(str);

export function isWorkerToEngine(x: unknown): x is WorkerToEngine {
  if (!isObj(x) || typeof x.t !== "string") return false;
  switch (x.t) {
    case "engine/fetch":
      return str(x.jobId) && Array.isArray(x.tracks) && x.tracks.every((t) => isObj(t) && str(t.trackId) && Array.isArray(t.chunks));
    case "engine/download":
      return str(x.jobId) && isObj(x.plan) && Array.isArray(x.tracks) && x.tracks.every(isRef) && Array.isArray(x.seeks);
    case "engine/gif":
      return str(x.jobId) && isObj(x.options) && isObj(x.src) && isObj(x.track) && isRef(x.track) && isObj(x.seek);
    case "engine/cancel":
    case "engine/discard":
      return str(x.jobId);
    case "engine/revoke":
      return str(x.url);
    case "engine/storage":
      return true;
    default:
      return false;
  }
}

export function isEngineToWorker(x: unknown): x is EngineToWorker {
  if (!isObj(x) || typeof x.t !== "string") return false;
  switch (x.t) {
    case "engine/ready":
      return isObj(x.storage) && num(x.storage.usage) && num(x.storage.quota) && typeof x.storage.persisted === "boolean";
    case "engine/commit":
      return str(x.jobId) && str(x.trackId) && str(x.key) && num(x.bytes);
    case "engine/progress":
      return str(x.jobId) && (x.phase === "fetch" || x.phase === "engine") && num(x.ratio);
    case "engine/fetched":
      return str(x.jobId) && typeof x.resumable === "boolean";
    case "engine/result":
      return str(x.jobId) && str(x.url) && num(x.bytes) && typeof x.mime === "string";
    case "engine/error":
      return str(x.jobId) && isObj(x.error) && typeof x.resumable === "boolean";
    default:
      return false;
  }
}
