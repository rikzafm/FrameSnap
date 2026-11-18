import { describe, expect, it, vi } from "vitest";
import { blobVariants, createCaptureRunner } from "../../src/content/capture";
import { FrameSnapError } from "../../src/core/errors";
import { isContentToWorker, isWorkerToContent, type ContentToWorker } from "../../src/core/messages";

function setup(over: { export?: () => Promise<unknown>; record?: (...a: never[]) => Promise<unknown>; video?: unknown } = {}) {
  const sent: ContentToWorker[] = [];
  const revoked: string[] = [];
  const video = "video" in over ? over.video : { duration: 20, currentTime: 5 };
  const runner = createCaptureRunner({
    detector: { resolve: () => video as never },
    mse: { export: (over.export ?? (async () => undefined)) as never },
    send: (m) => sent.push(m),
    urls: { create: () => "blob:https://site.test/out", revoke: (u) => revoked.push(u) },
    record: (over.record ?? (async () => ({ blob: new Blob(["rec"]), mime: "video/webm", container: "webm" }))) as never,
  });
  return { runner, sent, revoked };
}

describe("capture runner (content script)", () => {
  it("MSE: exports the stream and hands the worker a blob URL", async () => {
    const { runner, sent } = setup({ export: async () => ({ blob: new Blob(["abcd"]), mime: "video/mp4", container: "mp4", hasAudio: true }) });
    await runner.handle({ t: "capture/start", jobId: "j1", kind: "mse-capture", elementKey: "e1", streamId: "ms1" });
    expect(sent).toEqual([{ t: "capture/result", jobId: "j1", url: "blob:https://site.test/out", bytes: 4, mime: "video/mp4", container: "mp4", hasAudio: true }]);
  });

  it("MSE: reports not-found when the stream is gone", async () => {
    const { runner, sent } = setup();
    await runner.handle({ t: "capture/start", jobId: "j1", kind: "mse-capture", elementKey: "e1", streamId: "ms1" });
    expect(sent[0]).toMatchObject({ t: "capture/error", jobId: "j1", error: { code: "not-found" } });
  });

  it("recorder: records the requested seconds, relays progress, hands over the file", async () => {
    const record = vi.fn(async (_v: unknown, o: { durationSec: number; onProgress(r: number): void }) => {
      o.onProgress(0.5);
      return { blob: new Blob(["12345"]), mime: "video/webm", container: "webm" as const };
    });
    const { runner, sent } = setup({ record: record as never });
    await runner.handle({ t: "capture/start", jobId: "j2", kind: "recorder", elementKey: "e1", durationSec: 5 });
    expect(record.mock.calls[0]![1].durationSec).toBe(5);
    expect(sent).toEqual([
      { t: "capture/progress", jobId: "j2", ratio: 0.5 },
      { t: "capture/result", jobId: "j2", url: "blob:https://site.test/out", bytes: 5, mime: "video/webm", container: "webm", hasAudio: true },
    ]);
  });

  it("recorder: without a length it records what is left of the video", async () => {
    const record = vi.fn(async () => ({ blob: new Blob(["x"]), mime: "video/webm", container: "webm" as const }));
    const { runner } = setup({ record: record as never });
    await runner.handle({ t: "capture/start", jobId: "j2", kind: "recorder", elementKey: "e1" });
    expect((record.mock.calls[0] as unknown as [unknown, { durationSec: number }])[1].durationSec).toBe(15);
  });

  it("recorder: the element is gone", async () => {
    const { runner, sent } = setup({ video: undefined });
    await runner.handle({ t: "capture/start", jobId: "j3", kind: "recorder", elementKey: "e9", durationSec: 1 });
    expect(sent[0]).toMatchObject({ t: "capture/error", error: { code: "not-found" } });
  });

  it("recorder errors reach the worker as app errors", async () => {
    const { runner, sent } = setup({
      record: async () => {
        throw new FrameSnapError("unsupported", "the video must be playing to record it");
      },
    });
    await runner.handle({ t: "capture/start", jobId: "j4", kind: "recorder", elementKey: "e1", durationSec: 5 });
    expect(sent[0]).toMatchObject({ t: "capture/error", jobId: "j4", error: { code: "unsupported" } });
  });

  it("cancel aborts a running recording", async () => {
    let signal!: AbortSignal;
    const { runner, sent } = setup({
      record: ((_v: unknown, o: { signal: AbortSignal }) => {
        signal = o.signal;
        return new Promise((_res, rej) => o.signal.addEventListener("abort", () => rej(new FrameSnapError("cancelled"))));
      }) as never,
    });
    const run = runner.handle({ t: "capture/start", jobId: "j5", kind: "recorder", elementKey: "e1", durationSec: 30 });
    runner.handle({ t: "capture/cancel", jobId: "j5" });
    await run;
    expect(signal.aborted).toBe(true);
    expect(sent[0]).toMatchObject({ t: "capture/error", error: { code: "cancelled" } });
  });

  it("revoke frees the blob URL", async () => {
    const { runner, revoked } = setup();
    await runner.handle({ t: "capture/revoke", url: "blob:https://site.test/out" });
    expect(revoked).toEqual(["blob:https://site.test/out"]);
  });
});

describe("blob variants", () => {
  const video = { videoWidth: 1280, videoHeight: 720 };
  const stream = { id: "ms1", url: "blob:x", bytes: 900, truncated: false, tracks: [{ index: 0, mime: 'video/mp4; codecs="avc1.64001f"', kind: "video" as const, container: "mp4" as const, bytes: 900 }] };

  it("offers the MSE capture first, then the recorder", () => {
    const v = blobVariants(video, "blob:x", "e1", stream, true);
    expect(v.map((x) => x.kind)).toEqual(["mse-capture", "recorder"]);
    expect(v[0]).toMatchObject({ id: "mse:ms1", container: "mp4", hasAudio: false, height: 720, sizeBytes: 900 });
    expect(v[1]).toMatchObject({ id: "rec:e1", container: "webm", hasAudio: true });
  });

  it("offers only the recorder when no stream was captured, and nothing when recording is impossible", () => {
    expect(blobVariants(video, "blob:x", "e1", undefined, true).map((x) => x.kind)).toEqual(["recorder"]);
    expect(blobVariants(video, "blob:x", "e1", undefined, false)).toEqual([]);
  });
});

describe("capture messages", () => {
  it("are accepted by the guards and malformed ones are not", () => {
    expect(isWorkerToContent({ t: "capture/start", jobId: "j", kind: "recorder", elementKey: "e1", durationSec: 5 })).toBe(true);
    expect(isWorkerToContent({ t: "capture/start", jobId: "j", kind: "other", elementKey: "e1" })).toBe(false);
    expect(isWorkerToContent({ t: "capture/cancel", jobId: "j" })).toBe(true);
    expect(isContentToWorker({ t: "capture/result", jobId: "j", url: "blob:x", bytes: 1, mime: "video/mp4", container: "mp4", hasAudio: true })).toBe(true);
    expect(isContentToWorker({ t: "capture/result", jobId: "j", url: "blob:x", bytes: 1, mime: "video/mp4", container: "avi", hasAudio: true })).toBe(false);
    expect(isContentToWorker({ t: "capture/progress", jobId: "j", ratio: 0.2 })).toBe(true);
    expect(isContentToWorker({ t: "capture/error", jobId: "j", error: { code: "network", message: "m", retryable: true } })).toBe(true);
  });
});
