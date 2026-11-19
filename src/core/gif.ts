/** GIF tab logic with no DOM: trim limits, the rendition to fetch, the size range shown. */
import { FrameSnapError } from "./errors";
import { estimateGifBytes } from "./estimate";
import { formatBytes } from "./format";
import { GIF_DEFAULT_SECONDS, GIF_MAX_SECONDS, type GifOptions, type TrimRange, type Variant, type VideoSource } from "./model";
import { bestVariant } from "./rank";

/** Keyboard step of a trim handle, in seconds. */
export const GIF_TRIM_STEP = 0.5;
/** Shortest range the handles can leave. */
export const GIF_MIN_SECONDS = 0.1;

/** Start at the playhead, 2 s long, slid back when the clip ends sooner. */
export function defaultGifTrim(currentTime: number, duration: number | undefined): TrimRange {
  if (duration === undefined) return { start: Math.max(0, currentTime), end: Math.max(0, currentTime) + GIF_DEFAULT_SECONDS };
  const start = Math.max(0, Math.min(currentTime, duration - GIF_DEFAULT_SECONDS));
  return { start, end: Math.min(start + GIF_DEFAULT_SECONDS, duration) };
}

/** Keep a range inside the clip, at least GIF_MIN_SECONDS long and at most GIF_MAX_SECONDS. */
export function clampTrim(trim: TrimRange, duration: number | undefined): TrimRange {
  const total = duration ?? Infinity;
  let start = Math.min(Math.max(0, trim.start), Math.max(0, total - GIF_MIN_SECONDS));
  let end = Math.min(Math.max(trim.end, start + GIF_MIN_SECONDS), total);
  if (end - start > GIF_MAX_SECONDS) end = start + GIF_MAX_SECONDS;
  if (end - start < GIF_MIN_SECONDS) start = Math.max(0, end - GIF_MIN_SECONDS);
  return { start, end };
}

/** Move one handle by `steps` keyboard steps. Past the 30 s limit the other handle follows. */
export function moveHandle(trim: TrimRange, which: "start" | "end", steps: number, duration: number | undefined): TrimRange {
  return setHandle(trim, which, trim[which] + steps * GIF_TRIM_STEP, duration);
}

/** Pointer drags and Shift+arrow move handles in this step. */
export const GIF_DRAG_STEP = 0.1;
// toFixed drops float noise such as 0.30000000000000004
const snapDrag = (t: number) => Number((Math.round(t / GIF_DRAG_STEP) * GIF_DRAG_STEP).toFixed(3));

/**
 * Put one handle at `value`: it cannot cross the other handle, and a range
 * longer than GIF_MAX_SECONDS drags the other handle along.
 */
export function setHandle(trim: TrimRange, which: "start" | "end", value: number, duration: number | undefined): TrimRange {
  const total = duration ?? Infinity;
  if (which === "start") {
    const start = Math.min(Math.max(0, value), trim.end - GIF_MIN_SECONDS);
    const end = trim.end - start > GIF_MAX_SECONDS ? Math.min(start + GIF_MAX_SECONDS, total) : trim.end;
    return { start, end };
  }
  const end = Math.min(Math.max(value, trim.start + GIF_MIN_SECONDS), total);
  const start = end - trim.start > GIF_MAX_SECONDS ? end - GIF_MAX_SECONDS : trim.start;
  return { start, end };
}

/** A handle dragged to time `t`, snapped to GIF_DRAG_STEP. */
export const dragHandle = (trim: TrimRange, which: "start" | "end", t: number, duration: number | undefined): TrimRange => setHandle(trim, which, snapDrag(t), duration);

/** The handle a press at time `t` grabs: the nearer one (the end on a tie, so a collapsed range can still grow). */
export const nearestHandle = (trim: TrimRange, t: number): "start" | "end" => (Math.abs(t - trim.start) < Math.abs(t - trim.end) ? "start" : "end");

/** Slide the whole range by `delta` seconds, keeping its length and staying inside the clip. */
export function shiftRange(trim: TrimRange, delta: number, duration: number | undefined): TrimRange {
  const len = trim.end - trim.start;
  const total = duration ?? Infinity;
  const start = Math.min(Math.max(0, snapDrag(trim.start + delta)), Math.max(0, total - len));
  return { start, end: start + len };
}

/** The rendition worth fetching for a GIF: the smallest one that is at least as wide as the output. */
export function pickGifVariant(source: VideoSource, width: GifOptions["width"]): Variant {
  const sized = source.variants.filter((v) => v.width !== undefined);
  if (sized.length > 0) {
    const widest = [...sized].sort((a, b) => b.width! - a.width!);
    if (width === "original") return widest[0]!;
    const enough = sized.filter((v) => v.width! >= width).sort((a, b) => a.width! - b.width!);
    return enough[0] ?? widest[0]!;
  }
  const best = bestVariant(source.variants);
  if (!best) throw new FrameSnapError("unsupported", "no playable variant");
  return best;
}

/** Pixel size of the fetched rendition; 16:9 and 1280 wide stand in for what the manifest did not say. */
export function gifSourceSize(v: Pick<Variant, "width" | "height">): { width: number; height: number } {
  const width = v.width ?? (v.height ? Math.round((v.height * 16) / 9) : 1280);
  const height = v.height ?? Math.round((width * 9) / 16);
  return { width, height };
}

/** "≈ 3.4 MB–6.3 MB". The low-memory warning is `gifMemoryWarning` in the popup model. */
export function describeGif(options: GifOptions, src: { width: number; height: number }): { range: string } {
  const { low, high } = estimateGifBytes(options, src.width, src.height);
  return { range: `≈ ${formatBytes(low)}–${formatBytes(high)}` };
}
