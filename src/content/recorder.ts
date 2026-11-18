/**
 * MediaRecorder fallback for `blob:` videos with no readable MSE capture.
 * Records `video.captureStream()` in real time, so the video has to be playing
 * and the capture takes as long as the clip. Output is WebM.
 */
import { FrameSnapError } from "../core/errors";

export interface RecorderLike {
  state: string;
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(timeslice?: number): void;
  stop(): void;
}
export interface RecorderCtor {
  new (stream: unknown, options?: { mimeType?: string }): RecorderLike;
  isTypeSupported(type: string): boolean;
}

export interface CapturableVideo {
  paused: boolean;
  ended: boolean;
  captureStream(): unknown;
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
  container: "webm" | "mp4";
}

const PREFERRED = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
const TICK_MS = 250;

export function recordVideo(video: CapturableVideo, opts: RecordOptions): Promise<Recorded> {
  const Recorder = opts.Recorder ?? (globalThis as { MediaRecorder?: RecorderCtor }).MediaRecorder;
  if (!Recorder || typeof video.captureStream !== "function") return Promise.reject(new FrameSnapError("unsupported", "this browser cannot record the video"));
  if (video.paused || video.ended) return Promise.reject(new FrameSnapError("unsupported", "the video must be playing to record it"));
  if (opts.signal?.aborted) return Promise.reject(new FrameSnapError("cancelled"));

  return new Promise<Recorded>((resolve, reject) => {
    let rec: RecorderLike;
    try {
      const mimeType = PREFERRED.find((t) => Recorder.isTypeSupported(t));
      rec = new Recorder(video.captureStream(), mimeType ? { mimeType } : undefined);
    } catch (err) {
      reject(new FrameSnapError("unsupported", err instanceof Error ? err.message : "cannot record the video"));
      return;
    }
    const chunks: Blob[] = [];
    const total = Math.max(0.001, opts.durationSec) * 1000;
    const startedAt = Date.now();
    let outcome: "done" | "cancelled" = "done";
    const onEnded = () => finish("done");
    const onAbort = () => finish("cancelled");
    const tick = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      opts.onProgress?.(Math.min(1, elapsed / total));
      if (elapsed >= total) finish("done");
    }, TICK_MS);

    function cleanup() {
      clearInterval(tick);
      video.removeEventListener("ended", onEnded);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    function finish(why: "done" | "cancelled") {
      if (rec.state === "inactive") return;
      outcome = why;
      rec.stop();
    }

    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      cleanup();
      if (outcome === "cancelled") return reject(new FrameSnapError("cancelled"));
      const mime = (rec.mimeType || "video/webm").split(";")[0]!;
      opts.onProgress?.(1);
      resolve({ blob: new Blob(chunks, { type: mime }), mime, container: mime.includes("mp4") ? "mp4" : "webm" });
    };
    video.addEventListener("ended", onEnded);
    opts.signal?.addEventListener("abort", onAbort);
    rec.start(1000);
  });
}
