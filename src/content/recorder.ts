/**
 * MediaRecorder fallback for `blob:` videos with no readable MSE capture.
 * Records `video.captureStream()` in real time, so the video has to be playing
 * and the capture takes as long as the clip. Output is WebM, finalized so it has
 * a duration and a seek index (MediaRecorder writes neither).
 */
import { FrameSnapError } from '../core/errors';
import { finalizeWebm } from '../core/webm';

export interface RecorderLike {
  state: string;
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(timeslice?: number): void;
  stop(): void;
  pause?(): void;
  resume?(): void;
}
export interface RecorderCtor {
  new (stream: unknown, options?: { mimeType?: string }): RecorderLike;
  isTypeSupported(type: string): boolean;
}

export interface CapturableVideo {
  paused: boolean;
  ended: boolean;
  /** HTMLMediaElement.play(); the recorder starts a paused video itself when the page allows it. */
  play?(): Promise<void>;
  /** HTMLMediaElement.readyState; below 3 the video is waiting for data. */
  readyState?: number;
  captureStream?(): unknown;
  mozCaptureStream?(): unknown;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export interface RecordOptions {
  durationSec: number;
  Recorder?: RecorderCtor;
  signal?: AbortSignal;
  /** 0..1, by wall-clock time against the clip length. */
  onProgress?(ratio: number): void;
}

export interface Recorded {
  blob: Blob;
  mime: string;
  container: 'webm' | 'mp4';
}

const PREFERRED = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
];
const TICK_MS = 250;

/** Start a paused video; false when the page or the browser's autoplay rules refuse. */
async function ensurePlaying(video: CapturableVideo): Promise<boolean> {
  if (!video.paused && !video.ended) return true;
  if (video.ended || typeof video.play !== 'function') return false;
  try {
    await video.play();
  } catch {
    return false;
  }
  return !video.paused;
}

export async function recordVideo(video: CapturableVideo, opts: RecordOptions): Promise<Recorded> {
  const Recorder = opts.Recorder ?? (globalThis as { MediaRecorder?: RecorderCtor }).MediaRecorder;
  const capture =
    typeof video.captureStream === 'function'
      ? () => video.captureStream!()
      : typeof video.mozCaptureStream === 'function'
        ? () => video.mozCaptureStream!()
        : undefined;
  if (!Recorder || !capture)
    return Promise.reject(
      new FrameSnapError('unsupported', 'this browser cannot record the video'),
    );
  if (!(await ensurePlaying(video))) throw new FrameSnapError('not-playing');
  if (opts.signal?.aborted) return Promise.reject(new FrameSnapError('cancelled'));

  return new Promise<Recorded>((resolve, reject) => {
    let rec: RecorderLike;
    try {
      const mimeType = PREFERRED.find((t) => Recorder.isTypeSupported(t));
      rec = new Recorder(capture(), mimeType ? { mimeType } : undefined);
    } catch (err) {
      reject(
        new FrameSnapError(
          'unsupported',
          err instanceof Error ? err.message : 'cannot record the video',
        ),
      );
      return;
    }
    const chunks: Blob[] = [];
    const total = Math.max(0.001, opts.durationSec) * 1000;
    /** Time the video actually played: paused and buffering stretches do not count. */
    let played = 0;
    let lastTick = Date.now();
    let outcome: 'done' | 'cancelled' = 'done';
    const onEnded = () => finish('done');
    const onAbort = () => finish('cancelled');
    const tick = setInterval(() => {
      const at = Date.now();
      const stalled = video.paused || (video.readyState !== undefined && video.readyState < 3);
      if (stalled) {
        if (rec.state === 'recording') rec.pause?.();
      } else {
        if (rec.state === 'paused') rec.resume?.();
        played += at - lastTick;
      }
      lastTick = at;
      opts.onProgress?.(Math.min(1, played / total));
      if (played >= total) finish('done');
    }, TICK_MS);

    function cleanup() {
      clearInterval(tick);
      video.removeEventListener('ended', onEnded);
      opts.signal?.removeEventListener('abort', onAbort);
    }
    function finish(why: 'done' | 'cancelled') {
      if (rec.state === 'inactive') return;
      outcome = why;
      rec.stop();
    }

    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      cleanup();
      if (outcome === 'cancelled') return reject(new FrameSnapError('cancelled'));
      const mime = (rec.mimeType || 'video/webm').split(';')[0]!;
      const container = mime.includes('mp4') ? 'mp4' : 'webm';
      const raw = new Blob(chunks, { type: mime });
      void (container === 'webm' ? finalizeWebm(raw) : Promise.resolve(raw)).then((blob) => {
        opts.onProgress?.(1);
        resolve({ blob, mime, container });
      });
    };
    video.addEventListener('ended', onEnded);
    opts.signal?.addEventListener('abort', onAbort);
    rec.start(1000);
  });
}
