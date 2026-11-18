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

export interface DomDetectorOptions {
  document: Document;
  frameUrl: string;
  emit: (sources: VideoSource[]) => void;
  debounceMs?: number;
}

export interface DomDetector {
  /** Synchronous scan of the current DOM. */
  scan(): VideoSource[];
  /** Scan now, then keep reporting on DOM changes and media events. */
  start(): void;
  stop(): void;
  resolve(elementKey: string): HTMLVideoElement | undefined;
}

const THUMB_WIDTH = 160;
const MEDIA_EVENTS = ["loadedmetadata", "play", "pause", "ended"] as const;

function containerOf(url: string): Container {
  const path = url.split(/[?#]/)[0]!.toLowerCase();
  if (path.endsWith(".mp4") || path.endsWith(".m4v")) return "mp4";
  if (path.endsWith(".webm")) return "webm";
  if (path.endsWith(".ts")) return "ts";
  return "unknown";
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
  const { document: doc, frameUrl, emit, debounceMs = 100 } = opts;
  const keys = new WeakMap<HTMLVideoElement, string>();
  const byKey = new Map<string, WeakRef<HTMLVideoElement>>();
  const wired = new WeakSet<HTMLVideoElement>();
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

  function collect(root: Document | ShadowRoot, out: HTMLVideoElement[]) {
    if (running && !observedRoots.has(root)) {
      observedRoots.add(root);
      observer?.observe(root, { childList: true, subtree: true });
    }
    for (const el of root.querySelectorAll("*")) {
      if (el instanceof (doc.defaultView?.HTMLVideoElement ?? HTMLVideoElement)) out.push(el);
      if (el.shadowRoot) collect(el.shadowRoot, out);
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
    return source;
  }

  function wire(v: HTMLVideoElement) {
    if (wired.has(v)) return;
    wired.add(v);
    for (const ev of MEDIA_EVENTS) v.addEventListener(ev, schedule);
  }

  function scan(): VideoSource[] {
    const videos: HTMLVideoElement[] = [];
    collect(doc, videos);
    if (running) for (const v of videos) wire(v);
    return videos.map(describe);
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
  };
}
