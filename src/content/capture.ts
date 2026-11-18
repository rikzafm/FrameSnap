/**
 * Content-script side of the capture route (blob: sources). The worker asks
 * one frame to capture; the bytes never leave the page: the result is a
 * `blob:` URL that chrome.downloads saves, freed again on `capture/revoke`.
 *
 *   mse-capture  export the main-world hook's stream
 *   recorder     MediaRecorder on the playing <video>
 */
import { appError, toAppError } from "../core/errors";
import type { ContentToWorker, WorkerToContent } from "../core/messages";
import type { Variant } from "../core/model";
import type { ExportedStream, StreamInfo } from "../main-world/mse-hook";
import { recordVideo, type CapturableVideo, type RecordOptions, type Recorded } from "./recorder";

/** Variants for a `blob:` video: the MSE capture when the hook saw its stream, and the MediaRecorder fallback. */
export function blobVariants(
  video: { videoWidth: number; videoHeight: number },
  src: string,
  elementKey: string,
  stream: StreamInfo | undefined,
  canRecord: boolean,
): Variant[] {
  const size = { width: video.videoWidth || undefined, height: video.videoHeight || undefined };
  const out: Variant[] = [];
  const track = stream?.tracks.find((t) => t.kind === "muxed") ?? stream?.tracks.find((t) => t.kind === "video");
  if (stream && track && stream.bytes > 0) {
    const codecs = /codecs="?([^"]*)"?/.exec(track.mime)?.[1]?.split(",").map((c) => c.trim()) ?? [];
    out.push({
      id: `mse:${stream.id}`,
      kind: "mse-capture",
      url: src,
      container: track.container,
      ...(codecs[0] ? { videoCodec: codecs[0] } : {}),
      ...(track.kind === "muxed" && codecs[1] ? { audioCodec: codecs[1] } : {}),
      ...size,
      sizeBytes: stream.bytes,
      hasAudio: track.kind === "muxed",
    });
  }
  if (canRecord) out.push({ id: `rec:${elementKey}`, kind: "recorder", url: src, container: "webm", ...size, hasAudio: true });
  return out;
}

export interface CaptureRunnerDeps {
  detector: { resolve(elementKey: string): HTMLVideoElement | undefined };
  mse: { export(id: string): Promise<ExportedStream | undefined> };
  send(msg: ContentToWorker): void;
  urls: { create(b: Blob): string; revoke(url: string): void };
  record?(video: CapturableVideo, opts: RecordOptions): Promise<Recorded>;
}

export interface CaptureRunner {
  handle(msg: Extract<WorkerToContent, { t: "capture/start" | "capture/cancel" | "capture/revoke" }>): Promise<void>;
}

export function createCaptureRunner(deps: CaptureRunnerDeps): CaptureRunner {
  const record = deps.record ?? recordVideo;
  const running = new Map<string, AbortController>();

  async function run(msg: Extract<WorkerToContent, { t: "capture/start" }>, signal: AbortSignal): Promise<void> {
    let file: { blob: Blob; mime: string; container: "mp4" | "webm"; hasAudio: boolean };
    if (msg.kind === "mse-capture") {
      const out = msg.streamId ? await deps.mse.export(msg.streamId) : undefined;
      if (!out) throw Object.assign(new Error("stream gone"), { appError: appError("not-found") });
      file = out;
    } else {
      const video = deps.detector.resolve(msg.elementKey);
      if (!video) throw Object.assign(new Error("video gone"), { appError: appError("not-found") });
      const remaining = Number.isFinite(video.duration) ? Math.max(0, video.duration - video.currentTime) : 0;
      const durationSec = msg.durationSec ?? remaining;
      if (!(durationSec > 0)) throw Object.assign(new Error("no length"), { appError: appError("unsupported", "the length of this video is unknown") });
      const rec = await record(video as unknown as CapturableVideo, { durationSec, signal, onProgress: (ratio) => deps.send({ t: "capture/progress", jobId: msg.jobId, ratio }) });
      file = { ...rec, hasAudio: true };
    }
    deps.send({
      t: "capture/result",
      jobId: msg.jobId,
      url: deps.urls.create(file.blob),
      bytes: file.blob.size,
      mime: file.mime,
      container: file.container,
      hasAudio: file.hasAudio,
    });
  }

  return {
    async handle(msg) {
      if (msg.t === "capture/revoke") return deps.urls.revoke(msg.url);
      if (msg.t === "capture/cancel") return running.get(msg.jobId)?.abort();
      const ac = new AbortController();
      running.set(msg.jobId, ac);
      try {
        await run(msg, ac.signal);
      } catch (err) {
        const carried = (err as { appError?: ReturnType<typeof appError> }).appError;
        deps.send({ t: "capture/error", jobId: msg.jobId, error: carried ?? toAppError(err) });
      } finally {
        running.delete(msg.jobId);
      }
    },
  };
}
