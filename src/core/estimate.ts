/** Size estimates shown before any bytes move (spec §F2, §F3). */
import type { GifOptions, TrimRange, Variant } from "./model";

export interface SizeEstimate {
  bytes: number;
  /** "exact": Content-Length. "approx": derived. */
  confidence: "exact" | "approx";
}

/** Estimated output size of a download, before muxing overhead (≈1-2 %). */
export function estimateDownloadBytes(
  video: Variant | undefined,
  audioBytes: number | undefined,
  duration: number | undefined,
  trim?: TrimRange,
): SizeEstimate | undefined {
  const fraction = trim && duration ? clamp01((trim.end - trim.start) / duration) : 1;
  let videoBytes: number | undefined;
  let confidence: SizeEstimate["confidence"] = "approx";
  if (video?.sizeBytes !== undefined) {
    videoBytes = video.sizeBytes * fraction;
    confidence = fraction === 1 ? "exact" : "approx";
  } else if (video?.bitrate && duration) {
    videoBytes = (video.bitrate / 8) * duration * fraction;
  }
  if (videoBytes === undefined && audioBytes === undefined) return undefined;
  if (audioBytes !== undefined && confidence === "exact") confidence = "approx";
  return { bytes: Math.round((videoBytes ?? 0) + (audioBytes ?? 0) * fraction), confidence };
}

/**
 * GIF size heuristic: bytes ≈ w × h × frames × k. k was picked so the estimate
 * lands within ±35 % on typical clips; ticket 13 recalibrates it on the test
 * corpus. Returned as a range because content dominates.
 */
export const GIF_BYTES_PER_PIXEL = { dither: 0.55, flat: 0.35 } as const;

export function gifDimensions(opts: GifOptions, srcWidth: number, srcHeight: number): { width: number; height: number } {
  const width = opts.width === "original" ? srcWidth : Math.min(opts.width, srcWidth);
  // ffmpeg scale=W:-2 keeps aspect and rounds height to even
  const height = Math.max(2, Math.round((srcHeight * width) / srcWidth / 2) * 2);
  return { width, height };
}

export function gifFrameCount(opts: GifOptions): number {
  const fps = opts.fps === "source" ? 30 : opts.fps;
  return Math.max(1, Math.round((opts.trim.end - opts.trim.start) * fps));
}

export function estimateGifBytes(opts: GifOptions, srcWidth: number, srcHeight: number): { low: number; high: number } {
  const { width, height } = gifDimensions(opts, srcWidth, srcHeight);
  const k = opts.dither ? GIF_BYTES_PER_PIXEL.dither : GIF_BYTES_PER_PIXEL.flat;
  const mid = width * height * gifFrameCount(opts) * k;
  return { low: Math.round(mid * 0.65), high: Math.round(mid * 1.35) };
}

/** RGBA working set ffmpeg holds for palettegen (spec §7 low-memory warning). */
export function gifWorkingSetBytes(opts: GifOptions, srcWidth: number, srcHeight: number): number {
  const { width, height } = gifDimensions(opts, srcWidth, srcHeight);
  return width * height * 4 * gifFrameCount(opts);
}

export const GIF_LOW_MEMORY_BYTES = 600 * 1024 * 1024;

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
