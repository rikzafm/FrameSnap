/**
 * DOM video detection for one frame. Every frame runs its own detector
 * (manifest `all_frames`), so same-origin iframes are reported by their own
 * content script; this one walks the document and open shadow roots.
 *
 * `frameRef.frameId` is left at 0 here: a content script cannot know its own
 * frame id, the service worker fills it in from `sender.frameId`.
 */
import { fnv1a } from "../core/jobs/chunks";
import type { Container, DomFacts, Variant, VideoSource } from "../core/model";
import { redditGifOriginal } from "../adapters/reddit";

export interface DomDetectorOptions {
  document: Document;
  /** The frame's URL, or a getter for it: a single-page site (YouTube) changes it without a reload. */
  frameUrl: string | (() => string);
  emit: (sources: VideoSource[]) => void;
  debounceMs?: number;
  /** Extra variants for a blob: video (MSE capture, recorder). */
  blobVariants?: (video: HTMLVideoElement, src: string, elementKey: string) => Variant[];
}

export interface DomDetector {
  /** Synchronous scan of the current DOM. */
  scan(): VideoSource[];
  /** Scan now, then keep reporting on DOM changes and media events. */
  start(): void;
  stop(): void;
  resolve(elementKey: string): HTMLVideoElement | undefined;
  /** Re-report soon (a blob capture became available). */
  refresh(): void;
}

const THUMB_WIDTH = 160;
/** Smaller GIFs are spacers, tracking pixels and icons, not something to download. */
const GIF_MIN_PX = 48;
const MEDIA_EVENTS = ["loadedmetadata", "play", "pause", "ended"] as const;

/** The `format` query parameter (Reddit previews: mp4, png8, pjpg, gif). */
function formatParam(url: string): string | undefined {
  try {
    return new URL(url).searchParams.get("format")?.toLowerCase() ?? undefined;
  } catch {
    return undefined;
  }
}

function containerOf(url: string): Container {
  if (formatParam(url) === "mp4") return "mp4";
  const path = url.split(/[?#]/)[0]!.toLowerCase();
  if (path.endsWith(".mp4") || path.endsWith(".m4v")) return "mp4";
  if (path.endsWith(".webm")) return "webm";
  if (path.endsWith(".ts")) return "ts";
  return "unknown";
}

/** The URL of an animated-GIF image, when this <img> shows one. */
function gifUrlOf(img: HTMLImageElement): string | undefined {
  const src = img.currentSrc || img.src || "";
  if (!/^https?:/i.test(src)) return undefined;
  const path = src.split(/[?#]/)[0]!.toLowerCase();
  if (!path.endsWith(".gif")) return undefined;
  // a still or MP4 of a Reddit GIF: the original file is the one to save
  const original = redditGifOriginal(src);
  if (original) return original;
  const format = formatParam(src);
  return format === undefined || format === "gif" ? src : undefined;
}

/** Last path segment without ".gif", for the title of a GIF that has no alt text. */
function gifName(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return last.replace(/\.gif$/i, "");
  } catch {
    return "";
  }
}

function visibleRatio(r: { left: number; top: number; right: number; bottom: number }, win: Window | null): number {
  const area = (r.right - r.left) * (r.bottom - r.top);
  if (!(area > 0) || !win) return 0;
  const w = Math.min(r.right, win.innerWidth) - Math.max(r.left, 0);
  const h = Math.min(r.bottom, win.innerHeight) - Math.max(r.top, 0);
  return w > 0 && h > 0 ? (w * h) / area : 0;
}

function thumbnailOf(v: HTMLVideoElement): string | undefined {
  if (v.poster) return v.poster;
  if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) return undefined;
  try {
    const canvas = v.ownerDocument.createElement("canvas");
    canvas.width = THUMB_WIDTH;
    canvas.height = Math.max(1, Math.round((THUMB_WIDTH * v.videoHeight) / v.videoWidth));
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.7); // throws when the canvas is tainted
  } catch {
    return undefined;
  }
}

export function createDomDetector(opts: DomDetectorOptions): DomDetector {
  const { document: doc, emit, debounceMs = 100 } = opts;
  const urlOf = typeof opts.frameUrl === "function" ? opts.frameUrl : () => opts.frameUrl as string;
  const keys = new WeakMap<HTMLVideoElement, string>();
  const byKey = new Map<string, WeakRef<HTMLVideoElement>>();
  const wired = new WeakSet<HTMLVideoElement>();
  const wiredImages = new WeakSet<HTMLImageElement>();
  const observedRoots = new WeakSet<Node>();
  let counter = 0;
  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastSignature = "";
  let running = false;

  const keyOf = (v: HTMLVideoElement): string => {
    let k = keys.get(v);
    if (!k) {
      k = `e${++counter}`;
      keys.set(v, k);
      byKey.set(k, new WeakRef(v));
    }
    return k;
  };

  function collect(root: Document | ShadowRoot, out: HTMLVideoElement[], images: HTMLImageElement[]) {
    if (running && !observedRoots.has(root)) {
      observedRoots.add(root);
      observer?.observe(root, { childList: true, subtree: true });
    }
    for (const el of root.querySelectorAll("*")) {
      if (el instanceof (doc.defaultView?.HTMLVideoElement ?? HTMLVideoElement)) out.push(el);
      else if (el instanceof (doc.defaultView?.HTMLImageElement ?? HTMLImageElement)) images.push(el);
      if (el.shadowRoot) collect(el.shadowRoot, out, images);
    }
  }

  function describe(v: HTMLVideoElement): VideoSource {
    const elementKey = keyOf(v);
    const src = v.currentSrc || v.src || "";
    const rect = v.getBoundingClientRect();
    const dom: DomFacts = {
      visibleRatio: visibleRatio(rect, doc.defaultView),
      rectWidth: rect.width,
      rectHeight: rect.height,
      playing: !v.paused && !v.ended && v.readyState > 2,
      currentTime: v.currentTime,
    };
    const variants: Variant[] = [];
    if (/^https?:/i.test(src)) {
      variants.push({
        id: `p:${fnv1a(src)}`,
        kind: "progressive",
        url: src,
        container: containerOf(src),
        width: v.videoWidth || undefined,
        height: v.videoHeight || undefined,
        hasAudio: true,
      });
    }
    if (src.startsWith("blob:")) variants.push(...(opts.blobVariants?.(v, src, elementKey) ?? []));
    // Reddit plays an uploaded GIF as preview.redd.it/<id>.gif?format=mp4
    const gifUrl = /^https?:/i.test(src) ? redditGifOriginal(src) : undefined;
    if (gifUrl) for (const x of variants) x.hasAudio = false;
    const frameUrl = urlOf();
    const source: VideoSource = {
      id: `dom:${fnv1a(src || frameUrl + elementKey)}`,
      site: "generic",
      title: doc.title || "Video",
      pageUrl: frameUrl,
      thumbnail: thumbnailOf(v),
      variants,
      audioTracks: [],
      frameRef: { frameId: 0, elementKey },
      protection: v.mediaKeys ? "drm" : "none",
      detectedBy: ["dom"],
      dom,
    };
    if (Number.isFinite(v.duration) && v.duration > 0) source.duration = v.duration;
    if (gifUrl) {
      source.gifUrl = gifUrl;
      source.animatedGif = true;
    }
    return source;
  }

  /**
   * A GIF image as a source with one variant: the image's own URL. It has no
   * frameRef (it is not a <video>, so snap and seek do not apply to it).
   */
  function describeGif(img: HTMLImageElement, url: string): VideoSource | undefined {
    const rect = img.getBoundingClientRect();
    const width = img.naturalWidth || Math.round(rect.width);
    const height = img.naturalHeight || Math.round(rect.height);
    if (width < GIF_MIN_PX || height < GIF_MIN_PX) return undefined;
    const variant: Variant = { id: `g:${fnv1a(url)}`, kind: "progressive", url, container: "gif", width, height, hasAudio: false };
    return {
      id: `gif:${fnv1a(url)}`,
      site: "generic",
      title: img.alt.trim() || img.title.trim() || gifName(url) || doc.title || "GIF",
      pageUrl: urlOf(),
      thumbnail: url,
      variants: [variant],
      audioTracks: [],
      protection: "none",
      detectedBy: ["dom"],
      dom: { visibleRatio: visibleRatio(rect, doc.defaultView), rectWidth: rect.width, rectHeight: rect.height, playing: false },
    };
  }

  function wire(v: HTMLVideoElement) {
    if (wired.has(v)) return;
    wired.add(v);
    for (const ev of MEDIA_EVENTS) v.addEventListener(ev, schedule);
  }

  function scan(): VideoSource[] {
    const videos: HTMLVideoElement[] = [];
    const images: HTMLImageElement[] = [];
    collect(doc, videos, images);
    if (running) for (const v of videos) wire(v);
    const gifs = new Map<string, VideoSource>();
    for (const img of images) {
      const url = gifUrlOf(img);
      if (!url) continue;
      // its size is known once it loads
      if (running && !wiredImages.has(img)) {
        wiredImages.add(img);
        img.addEventListener("load", schedule);
      }
      if (gifs.has(url)) continue;
      const gif = describeGif(img, url);
      if (gif) gifs.set(url, gif);
    }
    return [...videos.map(describe), ...gifs.values()];
  }

  function report() {
    timer = undefined;
    const sources = scan();
    const signature = JSON.stringify(sources);
    if (signature === lastSignature) return;
    lastSignature = signature;
    emit(sources);
  }

  function schedule() {
    if (!running || timer !== undefined) return;
    timer = setTimeout(report, debounceMs);
  }

  return {
    scan,
    start() {
      if (running) return;
      running = true;
      observer = new MutationObserver(schedule);
      report();
    },
    stop() {
      running = false;
      observer?.disconnect();
      observer = undefined;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
    resolve: (k) => byKey.get(k)?.deref(),
    refresh: schedule,
  };
}
