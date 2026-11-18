/**
 * Site adapter contract (spec §F6). Adapters are pure: they read a snapshot
 * of the page (DOM facts + sniffed network hits) and describe videos. They
 * never touch chrome.*, so they run in the content script, the service worker
 * and Node tests alike.
 */
import type { SiteId, VideoSource } from "../core/model";
import type { parseMaster, parseMedia } from "../core/media/hls";
import type { parseMpd } from "../core/media/dash";

/** One <video> element as seen by the content script. */
export interface DomVideo {
  elementKey: string;
  frameId: number;
  /** currentSrc || src. May be blob: (MSE) and is then ignored by the generic adapter. */
  src: string;
  poster?: string;
  /** Seconds. */
  duration?: number;
  rectWidth: number;
  rectHeight: number;
  visibleRatio: number;
  playing: boolean;
  /** Intrinsic size, when metadata has loaded. */
  videoWidth?: number;
  videoHeight?: number;
}

/** A media response seen by the network sniffer. */
export interface NetworkHit {
  url: string;
  contentType?: string;
  contentLength?: number;
  acceptsRanges?: boolean;
  etag?: string;
}

export interface DetectContext {
  pageUrl: string;
  pageTitle: string;
  domVideos: readonly DomVideo[];
  network: readonly NetworkHit[];
  /** JSON payloads forwarded by a main-world network tap (X GraphQL). Untrusted shape. */
  tapped?: readonly unknown[];
}

export interface AdapterContext {
  fetchText(url: string, headers?: Record<string, string>): Promise<string>;
  parseMaster: typeof parseMaster;
  parseMedia: typeof parseMedia;
  parseMpd: typeof parseMpd;
}

export interface SiteAdapter {
  site: SiteId;
  matches(pageUrl: string): boolean;
  detect(ctx: DetectContext): VideoSource[];
  /** Expand a detected source (e.g. manifests into variants). Returns the source unchanged on bad input. */
  resolve?(src: VideoSource, ctx: AdapterContext): Promise<VideoSource>;
}
