import { describe, expect, it } from "vitest";
import { jobKey } from "../../src/background/job-store";
import type { JobRecord } from "../../src/core/jobs/job";
import type { Variant, VideoSource } from "../../src/core/model";
import { createHarness, type Harness } from "../helpers/orchestrator-harness";

function blobSource(variants: Variant[], over: Partial<VideoSource> = {}): VideoSource {
  return {
    id: "dom:1",
    site: "generic",
    title: "Blob clip",
    pageUrl: "https://p.test/watch",
    duration: 10,
    variants,
    audioTracks: [],
    protection: "none",
    detectedBy: ["dom"],
    frameRef: { frameId: 3, elementKey: "e1" },
    ...over,
  };
}
const recorder: Variant = { id: "rec:e1", kind: "recorder", url: "blob:https://p.test/1", container: "webm", hasAudio: true, height: 720 };
const mse: Variant = { id: "mse:ms1", kind: "mse-capture", url: "blob:https://p.test/1", container: "mp4", hasAudio: true, height: 720 };

const start = (h: Harness, id = "dom:1", quality = "best") => h.orch.download({ tabId: 7, sourceId: id, options: { format: "mp4", quality, audio: "keep", filenameTemplate: "{title}" } });

describe("download orchestrator: capture route", () => {
  it("asks the frame to record, saves the file it hands back under its real extension, then frees the blob", async () => {
    const h = createHarness({ sources: [blobSource([recorder])] });
    const jobId = await start(h);
    await h.until(() => h.captureSent.length === 1);
    expect(h.captureSent[0]).toEqual({ tabId: 7, frameId: 3, msg: { t: "capture/start", jobId, kind: "recorder", elementKey: "e1" } });
    expect(h.sent).toEqual([]); // the engine is not involved

    await h.orch.onCaptureMessage({ t: "capture/progress", jobId, ratio: 0.5 });
    expect(h.events).toContainEqual({ t: "progress", jobId, phase: "fetch", ratio: 0.5 });

    await h.orch.onCaptureMessage({ t: "capture/result", jobId, url: "blob:https://p.test/out", bytes: 1234, mime: "video/webm", container: "webm", hasAudio: true });
    await h.until(() => h.saved.length === 1);
    expect(h.saved[0]).toMatchObject({ url: "blob:https://p.test/out", filename: "Blob clip.webm" });

    h.complete(h.saved[0]!.id);
    expect(await h.finished(jobId)).toMatchObject({ t: "done", filename: "Blob clip.webm" });
    expect(h.captureSent.at(-1)).toEqual({ tabId: 7, frameId: 3, msg: { t: "capture/revoke", url: "blob:https://p.test/out" } });
    expect(h.history[0]).toMatchObject({ id: jobId, filename: "Blob clip.webm", bytes: 1234 });
    expect((h.area.data[jobKey(jobId)] as JobRecord).resumable).toBe(false);
  });

  it("MSE: names the stream from the variant id and ignores a trim (the buffered range is what it is)", async () => {
    const h = createHarness({ sources: [blobSource([mse])] });
    const jobId = await start(h);
    await h.until(() => h.captureSent.length === 1);
    expect(h.captureSent[0]!.msg).toEqual({ t: "capture/start", jobId, kind: "mse-capture", elementKey: "e1", streamId: "ms1" });
  });

  it("recorder: a trim sets the recording length", async () => {
    const h = createHarness({ sources: [blobSource([recorder])] });
    await h.orch.download({ tabId: 7, sourceId: "dom:1", options: { format: "mp4", quality: "best", audio: "keep", filenameTemplate: "{title}", trim: { start: 2, end: 7 } } });
    await h.until(() => h.captureSent.length === 1);
    expect(h.captureSent[0]!.msg).toMatchObject({ kind: "recorder", durationSec: 5 });
  });

  it("fails, not resumable, when the page cannot capture", async () => {
    const h = createHarness({ sources: [blobSource([recorder])] });
    const jobId = await start(h);
    await h.until(() => h.captureSent.length === 1);
    await h.orch.onCaptureMessage({ t: "capture/error", jobId, error: { code: "unsupported", message: "the video must be playing", retryable: false } });
    expect(await h.finished(jobId)).toMatchObject({ t: "failed", resumable: false, error: { code: "unsupported" } });
    expect(h.saved).toHaveLength(0);
  });

  it("cancel stops the page's capture and ends the job", async () => {
    const h = createHarness({ sources: [blobSource([recorder])] });
    const jobId = await start(h);
    await h.until(() => h.captureSent.length === 1);
    await h.orch.cancel(jobId);
    expect(h.captureSent.at(-1)!.msg).toEqual({ t: "capture/cancel", jobId });
    expect(await h.finished(jobId)).toEqual({ t: "cancelled", jobId });
    // a late result from the page is dropped and its blob freed
    await h.orch.onCaptureMessage({ t: "capture/result", jobId, url: "blob:late", bytes: 1, mime: "video/webm", container: "webm", hasAudio: true });
    expect(h.saved).toHaveLength(0);
    expect(h.captureSent.at(-1)!.msg).toEqual({ t: "capture/revoke", url: "blob:late" });
  });

  it("fails clearly when started without a tab to capture in", async () => {
    const h = createHarness();
    const jobId = await h.orch.start(blobSource([recorder]), { format: "mp4", quality: "best", audio: "keep", filenameTemplate: "{title}" });
    expect(await h.finished(jobId)).toMatchObject({ t: "failed", error: { code: "not-found" } });
  });
});
