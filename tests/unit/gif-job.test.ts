import { describe, expect, it } from "vitest";
import { jobKey } from "../../src/background/job-store";
import type { JobRecord } from "../../src/core/jobs/job";
import type { JobEvent } from "../../src/core/messages";
import type { GifOptions, VideoSource } from "../../src/core/model";
import * as fx from "../fixtures/hls-page";
import { bytes } from "../helpers/fake-cdn";
import { createHarness, progressive, type Harness } from "../helpers/orchestrator-harness";

const KB = 1024;
const gif = (over: Partial<GifOptions> = {}): GifOptions => ({ trim: { start: 3, end: 8 }, fps: 15, width: 480, loop: 0, dither: true, ...over });
type Ready = Extract<JobEvent, { t: "gif-ready" }>;

const ready = (h: Harness, jobId: string) => h.events.find((e): e is Ready => e.t === "gif-ready" && e.jobId === jobId);
async function make(opts: Partial<GifOptions> = {}, src: VideoSource = progressive("a", { duration: 20 }, { width: 1920, height: 1080 })) {
  const h = createHarness({ sources: [src] });
  h.cdn.put("/a.mp4", { body: bytes(10 * KB), etag: '"e"' });
  const jobId = await h.orch.startGif({ tabId: 1, sourceId: src.id, options: gif(opts) });
  await h.until(() => ready(h, jobId) !== undefined || h.events.some((e) => e.t === "failed" && e.jobId === jobId));
  return { h, jobId };
}

describe("GIF job", () => {
  it("fetches the range, renders it in two passes and offers the result for preview without saving", async () => {
    const { h, jobId } = await make();
    const msg = h.sent.find((m) => m.t === "engine/gif");
    expect(msg).toMatchObject({
      t: "engine/gif",
      options: gif(),
      src: { width: 1920, height: 1080 },
      track: { container: "mp4" },
      seek: { start: 3, length: 5 },
    });
    expect(h.backend.commands).toHaveLength(2); // palette pass, then render pass
    expect(h.backend.commands[1]).toContain("-loop");
    const r = ready(h, jobId)!;
    expect(r).toMatchObject({ filename: "Clip a.gif" });
    expect(h.blobs.get(r.url)).toBeInstanceOf(Blob);
    expect(r.bytes).toBe(h.blobs.get(r.url)!.size);
    expect(h.saved).toEqual([]); // nothing reaches chrome.downloads before Save
    expect((h.area.data[jobKey(jobId)] as JobRecord).kind).toBe("gif");
  });

  it("keeps the result while the popup is closed and lists it again for the next popup", async () => {
    const { h, jobId } = await make();
    expect(h.orch.pendingGifs()).toEqual([ready(h, jobId)]);
  });

  it("Save downloads the GIF, records history and frees the blob", async () => {
    const { h, jobId } = await make();
    const r = ready(h, jobId)!;
    await h.orch.saveGif(jobId);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ url: r.url, filename: "Clip a.gif" });
    h.complete(h.saved[0]!.id);
    await h.until(() => h.events.some((e) => e.t === "done" && e.jobId === jobId));
    expect(h.events.find((e) => e.t === "done")).toMatchObject({ filename: "Clip a.gif" });
    expect(h.history[0]).toMatchObject({ id: jobId, kind: "gif", filename: "Clip a.gif" });
    expect(h.blobs.has(r.url)).toBe(false);
    expect(h.orch.pendingGifs()).toEqual([]);
  });

  it("Discard drops the result and the kept chunks without saving", async () => {
    const { h, jobId } = await make();
    const r = ready(h, jobId)!;
    await h.orch.cancel(jobId);
    expect(h.events.some((e) => e.t === "cancelled" && e.jobId === jobId)).toBe(true);
    expect(h.blobs.has(r.url)).toBe(false);
    expect(h.saved).toEqual([]);
    expect(h.orch.pendingGifs()).toEqual([]);
    expect((await h.store.list(jobId, "0")).size).toBe(0);
  });

  it("fetches only the HLS segments inside the range and seeks into the first", async () => {
    const base = "https://cdn.example.org/hls/";
    const h = createHarness({ files: { [base + "720p.m3u8"]: fx.MEDIA_VOD } });
    for (const n of [0, 1, 2]) h.cdn.put(`/hls/s${n}.ts`, { body: bytes(3 * KB, n + 1) });
    const src: VideoSource = {
      id: "g:h",
      site: "generic",
      title: "Hls",
      pageUrl: "https://videos.example.org/watch/42",
      duration: 30,
      variants: [{ id: "hls:720", kind: "hls", url: base + "720p.m3u8", container: "ts", hasAudio: true, videoCodec: "avc1.64001f", audioCodec: "mp4a.40.2", width: 1280, height: 720 }],
      audioTracks: [],
      protection: "none",
      detectedBy: ["network"],
    };
    const jobId = await h.orch.startGifSource(src, gif({ trim: { start: 12, end: 18 } }));
    await h.until(() => ready(h, jobId) !== undefined);
    expect(h.cdn.log.map((l) => l.path)).toEqual(["/hls/s1.ts"]);
    expect(h.sent.find((m) => m.t === "engine/gif")).toMatchObject({ seek: { start: 2, length: 6 }, track: { container: "ts" } });
  });

  it("fetches the smallest rendition that is wide enough for the GIF", async () => {
    const src = progressive("a", { duration: 20 }, { width: 1920, height: 1080 });
    src.variants.push({ ...src.variants[0]!, id: "small", url: "https://cdn.test/small.mp4", width: 640, height: 360 });
    const h = createHarness({ sources: [src] });
    h.cdn.put("/small.mp4", { body: bytes(2 * KB), etag: '"s"' });
    const jobId = await h.orch.startGif({ tabId: 1, sourceId: "a", options: gif() });
    await h.until(() => ready(h, jobId) !== undefined);
    expect(h.cdn.log.some((l) => l.path === "/small.mp4")).toBe(true);
    expect(h.sent.find((m) => m.t === "engine/gif")).toMatchObject({ src: { width: 640, height: 360 } });
  });

  it("reports DRM before starting anything", async () => {
    const src = progressive("a", { protection: "drm" });
    const h = createHarness({ sources: [src] });
    const jobId = await h.orch.startGif({ tabId: 1, sourceId: "a", options: gif() });
    expect(await h.finished(jobId)).toMatchObject({ t: "failed", resumable: false });
  });

  it("fails the job when the engine runs out of memory; a GIF is retried from the popup, not resumed, so its chunks are dropped", async () => {
    const h = createHarness({ sources: [progressive("a", { duration: 20 }, { width: 1920, height: 1080 })] });
    h.cdn.put("/a.mp4", { body: bytes(10 * KB), etag: '"e"' });
    h.backend.exec = async () => {
      throw new Error("memory access out of bounds");
    };
    const jobId = await h.orch.startGif({ tabId: 1, sourceId: "a", options: gif() });
    const ev = await h.finished(jobId);
    expect(ev).toMatchObject({ t: "failed", resumable: false, keptRatio: 0 });
    expect((await h.store.list(jobId, "0")).size).toBe(0);
  });

  it("fails a ready preview when the converter goes away", async () => {
    const { h, jobId } = await make();
    await h.orch.onEngineDisconnect();
    await h.until(() => h.events.some((e) => e.t === "failed" && e.jobId === jobId));
    expect(h.orch.pendingGifs()).toEqual([]);
  });

  it("autoSave downloads the rendered GIF immediately without waiting for saveGif or emitting gif-ready", async () => {
    const src = progressive("a", { duration: 20 }, { width: 1920, height: 1080 });
    const h = createHarness({ sources: [src] });
    h.cdn.put("/a.mp4", { body: bytes(10 * KB), etag: '"e"' });

    const jobId = await h.orch.startGifSource(src, gif(), "{title}", { autoSave: true });
    await h.until(() => h.saved.length === 1 || h.events.some((e) => e.t === "failed" && e.jobId === jobId));

    expect(ready(h, jobId)).toBeUndefined();
    expect(h.orch.pendingGifs()).toEqual([]);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]).toMatchObject({ filename: "Clip a.gif" });
    const blobUrl = h.saved[0]!.url;

    h.complete(h.saved[0]!.id);
    await h.until(() => h.events.some((e) => e.t === "done" && e.jobId === jobId));
    expect(h.events.find((e) => e.t === "done")).toMatchObject({ filename: "Clip a.gif" });
    expect(h.history[0]).toMatchObject({ id: jobId, kind: "gif", filename: "Clip a.gif" });
    expect(h.blobs.has(blobUrl)).toBe(false);
    expect((await h.store.list(jobId, "0")).size).toBe(0);
  });
});
