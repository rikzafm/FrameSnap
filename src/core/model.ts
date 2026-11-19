/**
 * Core domain model. Pure types, no browser APIs.
 * Everything in src/core must run unchanged in the service worker, offscreen
 * document, content script and Node (tests).
 */

export type SiteId = "reddit" | "x" | "discord" | "youtube" | "generic";

export type VariantKind = "progressive" | "hls" | "dash" | "mse-capture" | "recorder";
/** "gif": an animated GIF image on the page, saved as the original file. */
export type Container = "mp4" | "webm" | "ts" | "fmp4" | "gif" | "unknown";
export type DetectedBy = "dom" | "network" | "adapter";

export interface Variant {
  id: string;
  kind: VariantKind;
  /** Media URL (progressive), media playlist (HLS) or MPD (DASH). */
  url: string;
  container: Container;
  videoCodec?: string;
  audioCodec?: string;
  width?: number;
  height?: number;
  /** Bits per second. */
  bitrate?: number;
  /** Content-Length, or estimate. */
  sizeBytes?: number;
  /** True when the rendition carries its own audio. */
  hasAudio: boolean;
  /** True when the server answered with `Accept-Ranges: bytes`. */
  acceptsRanges?: boolean;
  /** The server holds one request to about playback speed; short ranged requests each start fast. */
  throttled?: boolean;
  /** HLS/DASH: playlist is live (window moves). */
  live?: boolean;
}

export interface AudioTrack {
  id: string;
  kind: "progressive" | "hls" | "dash";
  url: string;
  codec?: string;
  bitrate?: number;
  language?: string;
  sizeBytes?: number;
}

/** Link from a VideoSource back to a <video> element in a page frame. */
export interface FrameRef {
  frameId: number;
  elementKey: string;
}

export interface VideoSource {
  /** Stable per page: adapter-canonical id, or hash of site + media URL. */
  id: string;
  site: SiteId;
  title: string;
  pageUrl: string;
  thumbnail?: string;
  /** Seconds. */
  duration?: number;
  variants: Variant[];
  audioTracks: AudioTrack[];
  /** Request headers the CDN needs (Referer/Origin). */
  headers?: Record<string, string>;
  frameRef?: FrameRef;
  protection: "none" | "drm";
  detectedBy: DetectedBy[];
  /** DOM facts used for ranking; absent for network-only finds. */
  dom?: DomFacts;
  /**
   * Adapter find that is the page's own main video (a YouTube watch page).
   * It claims the page's largest capture-only element even when their
   * lengths differ, as they do while an ad plays.
   */
  mainVideo?: true;
  /**
   * The original .gif file this video is a rendition of (Reddit serves an
   * uploaded GIF as MP4 but keeps the file). "Download GIF" saves it as is.
   */
  gifUrl?: string;
  /**
   * The site turned a GIF into this silent video and kept no .gif (X
   * animated_gif). "Download GIF" renders the whole clip back to GIF at full
   * width and the clip's own frame rate.
   */
  animatedGif?: true;
}

export interface DomFacts {
  /** Fraction of the element inside the viewport, 0..1. */
  visibleRatio: number;
  /** CSS pixels. */
  rectWidth: number;
  rectHeight: number;
  playing: boolean;
  /** Playhead in seconds when the page was read; the GIF tab starts its range here. */
  currentTime?: number;
}

/* ---------- user options ---------- */

export type VideoFormat = "mp4" | "webm" | "mkv" | "mov";
export type AudioFormat = "mp3" | "m4a";
/** The original file of a GIF image, saved byte for byte. */
export type ImageFormat = "gif";
export type OutputFormat = VideoFormat | AudioFormat | ImageFormat;
export type AudioMode = "keep" | "remove" | "only";

export interface TrimRange {
  /** Seconds, inclusive. */
  start: number;
  /** Seconds, exclusive. */
  end: number;
}

export interface DownloadOptions {
  format: OutputFormat;
  /** Variant id, or "best". */
  quality: string;
  audio: AudioMode;
  trim?: TrimRange;
  /** Re-encode so the cut lands on the exact frame. */
  frameAccurate?: boolean;
  filenameTemplate: string;
}

export interface GifOptions {
  trim: TrimRange;
  /** "source": keep every frame at the clip's own timing (no fps filter). */
  fps: 10 | 15 | 24 | 30 | "source";
  /** px, or "original". */
  width: 320 | 480 | 640 | "original";
  /** 0 = forever. */
  loop: number;
  dither: boolean;
}

/** A source that is a GIF image on the page rather than a video: it downloads as the original .gif. */
export function isGifImage(src: Pick<VideoSource, "variants">): boolean {
  return src.variants.length > 0 && src.variants.every((v) => v.container === "gif");
}

/** A video that can be saved as a .gif: from its original file, or rendered from the clip. */
export function hasGifDownload(src: Pick<VideoSource, "gifUrl" | "animatedGif" | "variants">): boolean {
  return !isGifImage(src) && (src.gifUrl !== undefined || src.animatedGif === true);
}

export const GIF_DEFAULT_SECONDS = 2;
export const LARGE_FILE_BYTES = 500 * 1024 * 1024;
