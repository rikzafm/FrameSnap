/**
 * Trim window over a segmented stream: fetch only the segments that overlap
 * the requested range, and tell ffmpeg where the range starts inside them.
 */
import type { TrimRange } from "../model";

export interface Timed {
  start: number;
  duration: number;
}

export interface SegmentWindow<T> {
  segments: T[];
  /** Seconds from the first kept segment's start to trim.start (ffmpeg -ss). */
  offset: number;
  /** trim.end - trim.start, clamped to what exists (ffmpeg -t). */
  length: number;
}

const EPS = 1e-6;

export function selectWindow<T extends Timed>(segments: readonly T[], trim?: TrimRange): SegmentWindow<T> {
  const total = segments.reduce((end, s) => Math.max(end, s.start + s.duration), 0);
  if (!trim) return { segments: [...segments], offset: 0, length: total };
  const start = Math.max(0, Math.min(trim.start, total));
  const end = Math.max(start, Math.min(trim.end, total));
  const kept = segments.filter((s) => s.start + s.duration > start + EPS && s.start < end - EPS);
  const first = kept[0];
  return { segments: kept, offset: first ? start - first.start : 0, length: end - start };
}
