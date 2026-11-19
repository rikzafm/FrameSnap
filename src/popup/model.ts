/**
 * Popup view models: pure functions from core data to what the popup shows.
 * No DOM, no chrome.* — the views in views.ts only render these.
 */
import { ERROR_COPY, FrameSnapError, toAppError, type AppError } from "../core/errors";
import { buildFilename } from "../core/filename";
import { formatBytes, formatSize, formatSpeed } from "../core/format";
import type { JobPhase, JobRecord } from "../core/jobs/job";
import { GIF_LOW_MEMORY_BYTES, gifWorkingSetBytes } from "../core/estimate";
import type { DownloadOptions, GifOptions, VideoSource } from "../core/model";
import { planDownload, type PlanWarning } from "../core/plan";

export { formatBytes };

const WARNING_TEXT: Record<PlanWarning, string> = {
  "large-file": "This is a large file. Make sure you have the disk space.",
  "too-large": ERROR_COPY["too-large"].message,
  "assumed-codecs": "Codecs could not be read, so the output may need extra conversion.",
  "capture-recorder": "This video has no download link, so it is recorded in real time. Keep it playing and this tab open. A recording cannot be resumed if it stops.",
  "capture-mse": "This video has no download link, so Frame Snap saves what the page has buffered so far. A capture cannot be resumed if it stops.",
};

export interface DownloadWarning {
  code: PlanWarning;
  text: string;
}

export interface DownloadDescription {
  estimate?: string;
  /** Raw estimated output size, used to turn progress ratios into bytes. */
  estimateBytes?: number;
  /** "720p" for the chosen rendition, when known. */
  heightLabel?: string;
  filename: string;
  warnings: DownloadWarning[];
  error?: AppError;
}

/** What the Format/Quality rows and the file name preview show for the current choices. */
export function describeDownload(source: VideoSource, options: DownloadOptions, date: Date): DownloadDescription {
  try {
    const plan = planDownload(source, options);
    const est = plan.estimate;
    return {
      estimateBytes: est?.bytes,
      heightLabel: plan.height ? `${plan.height}p` : undefined,
      estimate: est ? `${est.confidence === "approx" ? "≈ " : ""}${formatBytes(est.bytes)}` : undefined,
      filename: buildFilename(options.filenameTemplate, { title: source.title, site: source.site, date, height: plan.height }, plan.output.extension),
      warnings: plan.warnings.map((code) => ({ code, text: WARNING_TEXT[code] })),
    };
  } catch (err) {
    const error = err instanceof FrameSnapError ? err.appError : toAppError(err);
    return { filename: "", warnings: [], error };
  }
}

/** Low-memory warning for the GIF tab (working set above 600 MB), or undefined when it fits. */
export function gifMemoryWarning(opts: GifOptions, srcWidth: number, srcHeight: number): string | undefined {
  return gifWorkingSetBytes(opts, srcWidth, srcHeight) > GIF_LOW_MEMORY_BYTES
    ? "This GIF may use a lot of memory and could fail. Try a shorter range, a lower frame rate or a smaller width."
    : undefined;
}

export interface QualityChoice {
  value: string;
  label: string;
}

/** Short display name of a video codec string, or undefined when it is not one we name. */
export function codecName(codec: string | undefined): string | undefined {
  const c = codec?.toLowerCase() ?? "";
  if (c.startsWith("avc")) return "H.264";
  if (c.startsWith("hev") || c.startsWith("hvc")) return "HEVC";
  if (c.startsWith("vp09") || c.startsWith("vp9")) return "VP9";
  if (c.startsWith("vp8")) return "VP8";
  if (c.startsWith("av01")) return "AV1";
  return undefined;
}

export function qualityChoices(source: VideoSource): QualityChoice[] {
  const withHeight = source.variants.filter((v) => v.height !== undefined).sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  const perHeight = new Map<number, number>();
  for (const v of withHeight) perHeight.set(v.height!, (perHeight.get(v.height!) ?? 0) + 1);
  // YouTube offers each height in several codecs: name the codec only where the heights collide
  const label = (h: number, codec: string | undefined) => {
    const name = (perHeight.get(h) ?? 0) > 1 ? codecName(codec) : undefined;
    return name ? `${h}p · ${name}` : `${h}p`;
  };
  return [{ value: "best", label: "Best available" }, ...withHeight.map((v) => ({ value: v.id, label: label(v.height!, v.videoCodec) }))];
}

/* ---------- jobs ---------- */

export interface JobView {
  jobId: string;
  title: string;
  status: "queued" | "running" | "failed" | "done" | "cancelled";
  phase: JobPhase;
  ratio: number;
  error?: AppError;
  resumable?: boolean;
  keptRatio?: number;
  /** Expected size of the download, when the plan could estimate it. */
  totalBytes?: number;
  /** Bytes held so far, when the worker reports them. */
  doneBytes?: number;
  /** Smoothed transfer rate in bytes per second, while fetching. */
  speed?: number;
}

export type JobAction = "cancel" | "resume" | "retry";

export interface JobRowModel {
  jobId: string;
  title: string;
  label: string;
  percent: number;
  message?: string;
  /** "6.4 MB of 18 MB · 1.2 MB/s": downloaded so far, total size and speed. */
  detail?: string;
  actions: JobAction[];
  resumeLabel?: string;
}

const PHASE_LABEL: Record<JobPhase, string> = { fetch: "Downloading", engine: "Converting", save: "Saving" };
const pct = (r: number) => Math.round(Math.min(1, Math.max(0, r)) * 100);

/** Downloaded / total / speed line for the fetch phase; parts the data cannot give are left out. */
export function transferDetail(job: JobView): string | undefined {
  const total = job.totalBytes;
  const parts: string[] = [];
  if (total && total > 0) parts.push(`${formatSize(job.doneBytes ?? Math.min(1, Math.max(0, job.ratio)) * total)} of ${formatSize(total)}`);
  if (job.speed && job.speed > 0 && job.status === "running") parts.push(formatSpeed(job.speed));
  return parts.length ? parts.join(" · ") : undefined;
}

export function jobRowModel(job: JobView): JobRowModel {
  const base = { jobId: job.jobId, title: job.title, percent: pct(job.ratio) };
  switch (job.status) {
    case "queued":
    case "running":
      return { ...base, label: job.status === "queued" ? "Waiting" : PHASE_LABEL[job.phase], detail: job.phase === "fetch" ? transferDetail(job) : undefined, actions: ["cancel"] };
    case "done":
      return { ...base, percent: 100, label: "Saved", actions: [] };
    case "cancelled":
      return { ...base, label: "Cancelled", actions: [] };
    case "failed": {
      const error = job.error;
      const message = error ? ERROR_COPY[error.code].message : ERROR_COPY.internal.message;
      if (job.resumable) {
        return { ...base, label: "Stopped", message, actions: ["resume"], resumeLabel: `Resume (${pct(job.keptRatio ?? 0)} % kept)` };
      }
      return { ...base, label: "Failed", message, actions: error?.retryable ? ["retry"] : [] };
    }
  }
}

/* ---------- resume banner ---------- */

export interface ResumeBanner {
  text: string;
  jobIds: string[];
  many: boolean;
  jobs: { id: string; title: string; percent: number }[];
}

/** Banner above the list for the failed jobs the worker says can be resumed on this page. */
export function resumeBanner(jobs: readonly JobRecord[]): ResumeBanner | undefined {
  if (jobs.length === 0) return undefined;
  const items = jobs.map((j) => ({ id: j.id, title: j.source.title, percent: pct(j.progress) }));
  const first = items[0]!;
  return {
    text: jobs.length === 1 ? `Download stopped at ${first.percent} %: ${first.title}` : `${jobs.length} downloads can be resumed`,
    jobIds: items.map((i) => i.id),
    many: jobs.length > 1,
    jobs: items,
  };
}
