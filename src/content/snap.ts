/**
 * Frame snap in the page: pick the video, read its frame, fall back when the
 * frame is tainted, hand the image to the service worker for download.
 * Also frame-step and burst. Browser reads and UI are injected.
 */
import type { ContentToWorker } from '../core/messages';
import type { VideoSource } from '../core/model';
import { BURST_CAP, burstCount, stepTime, type SnapOptions } from '../core/snap';
import type { DomDetector } from './dom-detect';
import { captureFrame, captureViaCrossOrigin, type CaptureResult } from './snap-capture';

export interface SnapUi {
  flash(): void;
  toast(text: string, action?: { label: string; onClick: () => void | Promise<void> }): void;
}

export interface SnapperOptions {
  document: Document;
  detector: DomDetector;
  send(message: ContentToWorker): void;
  ui: SnapUi;
  capture?: (video: HTMLVideoElement, options: SnapOptions) => Promise<CaptureResult>;
  captureCors?: (video: HTMLVideoElement, options: SnapOptions) => Promise<CaptureResult>;
  /** Put a frame on the clipboard. False when the browser refused. */
  copy?: (blob: Blob) => Promise<boolean>;
}

export interface Snapper {
  capture(req: { elementKey?: string; options: SnapOptions }): Promise<boolean>;
  step(dir: 1 | -1, elementKey?: string): void;
  burst(req: { elementKey?: string; intervalSec: number; options: SnapOptions }): void;
  stopBurst(): void;
  readonly bursting: boolean;
  toast(text: string): void;
}

interface Target {
  video: HTMLVideoElement;
  source: VideoSource;
}

/** Playing first, then visible, then the biggest on screen. */
function score(s: VideoSource): number {
  const d = s.dom;
  if (!d) return 0;
  return (d.playing ? 1e12 : 0) + (d.visibleRatio > 0 ? 1e9 : 0) + d.rectWidth * d.rectHeight;
}

async function browserCopy(blob: Blob): Promise<boolean> {
  try {
    let png = blob;
    if (blob.type !== 'image/png') {
      const bmp = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      canvas.getContext('2d')!.drawImage(bmp, 0, 0);
      bmp.close();
      png = await canvas.convertToBlob({ type: 'image/png' });
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return true;
  } catch {
    return false;
  }
}

export function createSnapper(o: SnapperOptions): Snapper {
  const { document: doc, detector, send, ui } = o;
  const win = doc.defaultView!;
  const read = o.capture ?? ((v, opts) => captureFrame(v, opts));
  const readCors = o.captureCors ?? ((v, opts) => captureViaCrossOrigin(v, opts));
  const copy = o.copy ?? browserCopy;
  let burstTimer: ReturnType<typeof setTimeout> | undefined;
  let bursting = false;

  function target(elementKey?: string): Target | undefined {
    const sources = detector.scan();
    if (elementKey) {
      const video = detector.resolve(elementKey);
      const source = sources.find((s) => s.frameRef?.elementKey === elementKey);
      return video && source ? { video, source } : undefined;
    }
    const ranked = [...sources].sort((a, b) => score(b) - score(a));
    for (const source of ranked) {
      const video = source.frameRef ? detector.resolve(source.frameRef.elementKey) : undefined;
      if (video) return { video, source };
    }
    return undefined;
  }

  async function copyOrOffer(blob: Blob) {
    if (await copy(blob)) return;
    ui.toast('Could not copy automatically.', {
      label: 'Copy',
      onClick: async () => void (await copy(blob)),
    });
  }

  async function capture(req: { elementKey?: string; options: SnapOptions }): Promise<boolean> {
    const t = target(req.elementKey);
    if (!t) return false;
    const { video, source } = t;
    const { options } = req;
    ui.flash();
    let r = await read(video, options);
    if (!r.ok && r.reason === 'tainted') r = await readCors(video, options);
    if (r.ok) {
      send({
        t: 'snap/data',
        dataUrl: r.dataUrl,
        width: r.width,
        height: r.height,
        time: r.time,
        title: source.title,
        site: source.site,
        format: options.format,
      });
      if (options.copy) await copyOrOffer(r.blob);
      return true;
    }
    if (r.reason === 'tainted') {
      const rect = video.getBoundingClientRect();
      send({
        t: 'snap/tainted',
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        dpr: win.devicePixelRatio || 1,
        time: video.currentTime,
        title: source.title,
        site: source.site,
        format: options.format,
        quality: options.quality,
      });
      return true;
    }
    ui.toast('No frame to capture yet. Let the video load, then try again.');
    return false;
  }

  function stopBurst() {
    if (burstTimer) clearTimeout(burstTimer);
    burstTimer = undefined;
    bursting = false;
  }

  return {
    capture,
    step(dir, elementKey) {
      const t = target(elementKey);
      if (!t) return;
      t.video.pause();
      const duration = Number.isFinite(t.video.duration)
        ? t.video.duration
        : t.video.currentTime + 1;
      t.video.currentTime = stepTime(t.video.currentTime, dir, duration);
    },
    burst({ elementKey, intervalSec, options }) {
      stopBurst();
      const t = target(elementKey);
      if (!t) return;
      const total = Math.min(
        BURST_CAP,
        burstCount({
          interval: intervalSec,
          from: t.video.currentTime,
          ...(Number.isFinite(t.video.duration) ? { duration: t.video.duration } : {}),
        }),
      );
      let taken = 0;
      bursting = true;
      const tick = async () => {
        if (!bursting) return;
        const ok = await capture({ ...(elementKey ? { elementKey } : {}), options });
        taken += 1;
        if (!bursting) return;
        if (!ok || taken >= total || t.video.ended) {
          stopBurst();
          return;
        }
        burstTimer = setTimeout(() => void tick(), Math.max(0.1, intervalSec) * 1000);
      };
      void tick();
    },
    stopBurst,
    get bursting() {
      return bursting;
    },
    toast: (text) => ui.toast(text),
  };
}
