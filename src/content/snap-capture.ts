/**
 * Read the frame on screen from a <video> without pausing it:
 * requestVideoFrameCallback (so we grab a presented frame) then
 * createImageBitmap at the video's native size, encoded on an OffscreenCanvas.
 * Browser calls are injected so the flow is testable without a real decoder.
 */
import { mimeOf, type SnapOptions } from '../core/snap';

export interface FrameBitmap {
  width: number;
  height: number;
  close?(): void;
}

export interface CaptureDeps {
  /** Resolves when the next video frame is presented (or soon after, if the browser cannot say). */
  nextFrame(video: HTMLVideoElement): Promise<void>;
  bitmap(video: HTMLVideoElement): Promise<FrameBitmap>;
  encode(bitmap: FrameBitmap, mime: string, quality: number): Promise<Blob>;
  toDataUrl(blob: Blob): Promise<string>;
}

export type CaptureResult =
  | { ok: true; blob: Blob; dataUrl: string; width: number; height: number; time: number }
  | { ok: false; reason: 'tainted' | 'unavailable' };

export async function captureFrame(
  video: HTMLVideoElement,
  options: SnapOptions,
  deps: CaptureDeps = browserDeps,
): Promise<CaptureResult> {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight)
    return { ok: false, reason: 'unavailable' };
  if (!video.paused) await deps.nextFrame(video);
  const time = video.currentTime;
  let bmp: FrameBitmap;
  try {
    bmp = await deps.bitmap(video);
  } catch (e) {
    if (e instanceof DOMException && e.name === 'SecurityError')
      return { ok: false, reason: 'tainted' };
    return { ok: false, reason: 'unavailable' };
  }
  try {
    const blob = await deps.encode(bmp, mimeOf(options.format), options.quality);
    return {
      ok: true,
      blob,
      dataUrl: await deps.toDataUrl(blob),
      width: bmp.width,
      height: bmp.height,
      time,
    };
  } catch {
    return { ok: false, reason: 'unavailable' };
  } finally {
    bmp.close?.();
  }
}

/** Frame callbacks do not fire for a stalled or hidden video, so never wait long. */
const FRAME_WAIT_MS = 100;

export const browserDeps: CaptureDeps = {
  nextFrame: (video) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, FRAME_WAIT_MS);
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(() => {
          clearTimeout(timer);
          resolve();
        });
      }
    }),
  bitmap: (video) => createImageBitmap(video),
  async encode(bmp, mime, quality) {
    const canvas = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(bmp as ImageBitmap, 0, 0);
    return canvas.convertToBlob({ type: mime, quality });
  },
  toDataUrl: (blob) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    }),
};

const CLONE_WAIT_MS = 8000;

/**
 * Fallback A: the page video is cross-origin and tainted. Load the same source
 * in a detached element with `crossorigin=anonymous`, seek to the same time and
 * capture that copy. Works only when the host sends CORS headers.
 */
export async function captureViaCrossOrigin(
  video: HTMLVideoElement,
  options: SnapOptions,
  deps: CaptureDeps = browserDeps,
  make: () => HTMLVideoElement = () => document.createElement('video'),
): Promise<CaptureResult> {
  const src = video.currentSrc;
  const failed: CaptureResult = { ok: false, reason: 'tainted' };
  if (!src || src.startsWith('blob:')) return failed;
  const time = video.currentTime;
  const clone = make();
  const once = (type: string) =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), CLONE_WAIT_MS);
      clone.addEventListener(type, () => (clearTimeout(timer), resolve(true)), { once: true });
      clone.addEventListener('error', () => (clearTimeout(timer), resolve(false)), { once: true });
    });
  try {
    clone.crossOrigin = 'anonymous';
    clone.muted = true;
    clone.preload = 'auto';
    const loaded = once('loadedmetadata');
    clone.src = src;
    if (!(await loaded)) return failed;
    const seeked = once('seeked');
    clone.currentTime = time;
    if (!(await seeked)) return failed;
    const r = await captureFrame(clone, options, deps);
    return r.ok ? { ...r, time } : failed;
  } finally {
    clone.removeAttribute('src');
    clone.remove();
  }
}
