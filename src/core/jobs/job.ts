/**
 * Job records: the persisted half of resume. Stored in chrome.storage.local
 * under `jobs/<id>`; JSON-safe (no Blobs, no typed arrays). All transitions
 * are pure and return a new record.
 *
 *   queued ─► running ─┬─► done
 *                      ├─► failed ─► (resume) running
 *                      └─► cancelled
 */
import { appError, type AppError } from "../errors";
import type { Seek } from "../ffmpeg-args";
import type { DownloadOptions, GifOptions } from "../model";
import type { DownloadPlan } from "../plan";
import { layoutHash, type TrackPlan } from "./chunks";
import { sameMedia, type MatchResult, type SourceRef, type TrackValidators } from "./source-ref";

export type JobStatus = "queued" | "running" | "failed" | "done" | "cancelled";
export type JobPhase = "fetch" | "engine" | "save";

export interface TrackState {
  trackId: string;
  role: TrackPlan["role"];
  /** All chunk keys in plan order. */
  keys: string[];
  committed: string[];
  totalBytes?: number;
  validators: TrackValidators;
}

export interface JobRecord {
  id: string;
  kind: "download" | "gif";
  status: JobStatus;
  phase: JobPhase;
  createdAt: number;
  updatedAt: number;
  filename: string;
  source: SourceRef;
  options: DownloadOptions | GifOptions;
  plan: DownloadPlan;
  tracks: TrackState[];
  progress: number;
  attempts: number;
  resumable: boolean;
  error?: AppError;
  downloadId?: number;
  /** The session header rule this job holds, so a restarted service worker can tell live rules from stale ones. */
  ruleId?: number;
  /** ffmpeg seeks per input (null = none); JSON has no undefined. A restarted service worker needs them to finish the job. */
  seeks?: (Seek | null)[];
}

export function newJob(init: {
  id: string;
  kind: JobRecord["kind"];
  filename: string;
  source: SourceRef;
  options: JobRecord["options"];
  plan: DownloadPlan;
  now: number;
}): JobRecord {
  return {
    ...init,
    status: "queued",
    phase: "fetch",
    createdAt: init.now,
    updatedAt: init.now,
    tracks: [],
    progress: 0,
    attempts: 0,
    resumable: init.plan.resumable,
  };
}

export function trackValidators(track: TrackPlan, http?: { etag?: string | null; lastModified?: string | null; contentLength?: number }): TrackValidators {
  return {
    etag: http?.etag ?? undefined,
    lastModified: http?.lastModified ?? undefined,
    contentLength: http?.contentLength ?? track.totalBytes,
    layout: layoutHash(track.chunks),
  };
}

export function withTracks(job: JobRecord, tracks: readonly { plan: TrackPlan; validators: TrackValidators }[], now: number): JobRecord {
  return {
    ...job,
    tracks: tracks.map(({ plan, validators }) => ({
      trackId: plan.trackId,
      role: plan.role,
      keys: plan.chunks.map((c) => c.key),
      committed: [],
      totalBytes: plan.totalBytes,
      validators,
    })),
    updatedAt: now,
  };
}

export function start(job: JobRecord, now: number): JobRecord {
  return { ...job, status: "running", attempts: job.attempts + 1, error: undefined, updatedAt: now };
}

/** Record committed chunks (batched by the caller). */
export function commitChunks(job: JobRecord, commits: readonly { trackId: string; key: string }[], now: number): JobRecord {
  if (commits.length === 0) return job;
  const tracks = job.tracks.map((t) => {
    const add = commits.filter((c) => c.trackId === t.trackId).map((c) => c.key);
    if (add.length === 0) return t;
    const set = new Set([...t.committed, ...add]);
    return { ...t, committed: t.keys.filter((k) => set.has(k)) };
  });
  const total = tracks.reduce((s, t) => s + t.keys.length, 0);
  const done = tracks.reduce((s, t) => s + t.committed.length, 0);
  return { ...job, tracks, progress: total ? done / total : 0, updatedAt: now };
}

export function enterPhase(job: JobRecord, phase: JobPhase, now: number): JobRecord {
  return { ...job, phase, updatedAt: now };
}

export function fail(job: JobRecord, error: AppError, now: number): JobRecord {
  return { ...job, status: "failed", error, resumable: job.plan.resumable && error.retryable, updatedAt: now };
}

export function finish(job: JobRecord, downloadId: number, now: number): JobRecord {
  return { ...job, status: "done", phase: "save", progress: 1, downloadId, error: undefined, updatedAt: now };
}

export function cancel(job: JobRecord, now: number): JobRecord {
  return { ...job, status: "cancelled", resumable: false, updatedAt: now };
}

/** Fraction of a job's chunks that are already fetched (the "62 % kept" label). */
export function keptRatio(j: JobRecord | undefined): number {
  if (!j) return 0;
  const total = j.tracks.reduce((s, t) => s + t.keys.length, 0);
  return total ? j.tracks.reduce((s, t) => s + t.committed.length, 0) / total : 0;
}

export function fetchComplete(job: JobRecord): boolean {
  return job.tracks.length > 0 && job.tracks.every((t) => t.committed.length === t.keys.length);
}

/**
 * After a service-worker or browser restart, a "running" job has no live
 * worker behind it. It becomes a resumable failure.
 */
export function recoverInterrupted(jobs: readonly JobRecord[], now: number): JobRecord[] {
  return jobs.map((j) => (j.status === "running" || j.status === "queued" ? fail(j, appError("network", "interrupted"), now) : j));
}

/** Failed jobs the popup should offer to resume on this page. */
export function resumableOn(jobs: readonly JobRecord[], canonicalUrl: string): JobRecord[] {
  return jobs.filter((j) => j.kind !== "gif" && j.status === "failed" && j.resumable && j.source.pageUrl === canonicalUrl).sort((a, b) => b.updatedAt - a.updatedAt);
}

export type ResumeDecision =
  /** Keep the listed committed keys per track; fetch the rest. */
  | { action: "continue"; keep: Map<string, string[]>; keptRatio: number }
  /** Media changed: wipe chunks, start from zero. */
  | { action: "restart"; reason: "changed" }
  /** Could not identify the video: ask the user to pick it. */
  | { action: "pick"; reason: "not-found" | "ambiguous" };

/**
 * Decide how to resume once the page has been re-detected and fresh tracks
 * have been planned from the fresh URLs.
 */
export function decideResume(job: JobRecord, match: MatchResult, fresh: readonly { plan: TrackPlan; validators: TrackValidators }[]): ResumeDecision {
  if (match.status !== "found") return { action: "pick", reason: match.status };
  if (fresh.length !== job.tracks.length) return { action: "restart", reason: "changed" };

  const keep = new Map<string, string[]>();
  let kept = 0;
  let total = 0;
  for (const old of job.tracks) {
    const now = fresh.find((f) => f.plan.trackId === old.trackId && f.plan.role === old.role);
    if (!now || !sameMedia(old.validators, now.validators)) return { action: "restart", reason: "changed" };
    const valid = new Set(now.plan.chunks.map((c) => c.key));
    const keys = old.committed.filter((k) => valid.has(k));
    keep.set(old.trackId, keys);
    kept += keys.length;
    total += now.plan.chunks.length;
  }
  return { action: "continue", keep, keptRatio: total ? kept / total : 0 };
}
