/** Frame snap: options, burst and frame-step maths, crop geometry. Pure. */

export type SnapFormat = "png" | "jpeg" | "webp";

export interface SnapOptions {
  format: SnapFormat;
  /** 0..1, used by jpeg and webp. */
  quality: number;
  /** Also copy the frame to the clipboard. */
  copy: boolean;
  /** Show the floating Snap button on videos. */
  showButton: boolean;
}

export const DEFAULT_SNAP_OPTIONS: SnapOptions = { format: "png", quality: 0.92, copy: false, showButton: true };
export const SNAP_PREFS_KEY = "snap/prefs";
export const BURST_CAP = 200;
/** Browsers do not expose the frame rate; 30 fps is the step size. */
export const FRAME_STEP_SECONDS = 1 / 30;

const FORMATS: readonly string[] = ["png", "jpeg", "webp"];

export const mimeOf = (f: SnapFormat): string => `image/${f}`;
export const extensionOf = (f: SnapFormat): string => (f === "jpeg" ? "jpg" : f);

export function normalizeSnapOptions(raw: unknown): SnapOptions {
  const out = { ...DEFAULT_SNAP_OPTIONS };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.format === "string" && FORMATS.includes(r.format)) out.format = r.format as SnapFormat;
  if (typeof r.quality === "number" && Number.isFinite(r.quality)) out.quality = Math.min(1, Math.max(0.1, r.quality));
  if (typeof r.copy === "boolean") out.copy = r.copy;
  if (typeof r.showButton === "boolean") out.showButton = r.showButton;
  return out;
}

/** How many frames a burst takes: one per `interval` seconds to the end of the clip, at most BURST_CAP. */
export function burstCount(o: { interval: number; from: number; duration?: number }): number {
  const interval = o.interval > 0 ? o.interval : 1;
  if (o.duration === undefined || !Number.isFinite(o.duration)) return BURST_CAP;
  const n = Math.floor(Math.max(0, o.duration - o.from) / interval);
  return Math.min(BURST_CAP, Math.max(1, n));
}

export function stepTime(current: number, dir: 1 | -1, duration: number): number {
  return Math.min(duration, Math.max(0, current + dir * FRAME_STEP_SECONDS));
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Crop for a `captureVisibleTab` bitmap: CSS rect to device pixels, clipped to the capture. */
export function cropRect(css: Rect, dpr: number, capture: { width: number; height: number }): Rect {
  const x0 = Math.max(0, Math.round(css.x * dpr));
  const y0 = Math.max(0, Math.round(css.y * dpr));
  const x1 = Math.min(capture.width, Math.round((css.x + css.width) * dpr));
  const y1 = Math.min(capture.height, Math.round((css.y + css.height) * dpr));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}
