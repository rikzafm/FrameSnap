import { describe, expect, it } from "vitest";
import { jobKey } from "../../src/background/job-store";
import type { JobRecord } from "../../src/core/jobs/job";
import { parseMpd } from "../../src/core/media/dash";
import type { VideoSource } from "../../src/core/model";
import * as fx from "../fixtures/hls-page";
import { bytes, sameBytes } from "../helpers/fake-cdn";
import { createHarness, progressive } from "../helpers/orchestrator-harness";

const KB = 1024;
const MB = 1024 * KB;

describe("download orchestrator: direct route", () => {
  it("hands a small MP4 to chrome.downloads with a built file name and records history", async () => {
    const src = progressive("a", { site: "reddit" });
    const h = createHarness({ sources: [src] });
    h.cdn.put("/a.mp4", { body: bytes(10 * KB), etag: '"e"' });

    const jobId = await h.download("a", { filenameTemplate: "{title}-{site}-{resolution}" });
    expect(h.events[0]).toEqual({ t: "queued", jobId });
    await h.until(() => h.saved.length === 1);
    expect(h.saved[0]).toMatchObject({ url: "https://cdn.test/a.mp4", filename: "Clip a-reddit-720p.mp4" });
    expect(h.sent).toEqual([]); // no engine involved

    h.complete(h.saved[0]!.id);
    expect(await h.finished(jobId)).toMatchObject({ t: "done", downloadId: 1, filename: "Clip a-reddit-720p.mp4" });
    const rec = h.area.data[jobKey(jobId)] as JobRecord;
    expect(rec).toMatchObject({ status: "done", downloadId: 1 });
    expect(h.history).toHaveLength(1);
    expect(h.history[0]).toMatchObject({ id: jobId, filename: "Clip a-reddit-720p.mp4", site: "reddit", pageUrl: "https://p.test/watch" });
  });

  it("resumes an interrupted download when Chrome says it can", async () => {
    const h = createHarness({ sources: [progressive("a")] });
    const jobId = await h.download("a");
    await h.until(() => h.saved.length === 1);
    h.canResume.set(1, true);
    h.interrupt(1);
    await h.until(() => h.resumed.length === 1);
    expect(h.resumed).toEqual([1]);
    h.complete(1);
    expect((await h.finished(jobId)).t).toBe("done");
  });

  it("removes the partial file and fails the job when it cannot resume", async () => {
    const h = createHarness({ sources: [progressive("a")] });
    const jobId = await h.download("a");
    await h.until(() => h.saved.length === 1);
    h.interrupt(1, "SERVER_FORBIDDEN");
    const ev = await h.finished(jobId);
    expect(ev).toMatchObject({ t: "failed", resumable: false, keptRatio: 0 });
    expect(ev.t === "failed" && ev.error.code).toBe("expired");
    expect(h.removedFiles).toEqual([1]);
    expect(h.erased).toEqual([1]);
    expect(h.history).toHaveLength(0);
  });

  it("sets Referer/Origin through a session rule for the job and removes it afterwards", async () => {
    const h = createHarness({ sources: [progressive("a", { headers: { Referer: "https://p.test/", Origin: "https://p.test" } })] });
    const jobId = await h.download("a");
    await h.until(() => h.saved.length === 1);
    const [rule] = [...h.rules.values()];
    expect(rule!.action.requestHeaders).toEqual([
      { header: "Referer", operation: "set", value: "https://p.test/" },
      { header: "Origin", operation: "set", value: "https://p.test" },
    ]);
    expect(rule!.condition.requestDomains).toEqual(["cdn.test"]);
    // only requests that belong to no tab (offscreen document, service worker, downloads), never a page the user has open
    expect(rule!.condition.tabIds).toEqual([-1]);
    h.complete(1);
    await h.finished(jobId);
    expect(h.rules.size).toBe(0);
  });
});

describe("download orchestrator: planning errors", () => {
  it("reports DRM before starting anything", async () => {
    const h = createHarness({ sources: [progressive("a", { protection: "drm" })] });
    const jobId = await h.download("a");
    expect(await h.finished(jobId)).toMatchObject({ t: "failed", resumable: false });
    expect(h.saved).toHaveLength(0);
    expect(Object.keys(h.area.data)).toEqual([]);
  });

  it("refuses a file that is too large for the engine", async () => {
    const h = createHarness({ sources: [progressive("a", {}, { sizeBytes: 2 * 1024 * MB })] });
    const jobId = await h.download("a", { format: "mkv" });
    const ev = await h.finished(jobId);
    expect(ev.t === "failed" && ev.error.code).toBe("too-large");
    expect(h.sent).toEqual([]);
  });

  it("reports a video that is no longer detected", async () => {
    const h = createHarness({ sources: [] });
    const jobId = await h.download("gone");
    const ev = await h.finished(jobId);
    expect(ev.t === "failed" && ev.error.code).toBe("not-found");
  });
});

const bytesOf = async (b: Blob | undefined) => new Uint8Array(await b!.arrayBuffer());

/** Waits for the save and lets Chrome finish the download. */
async function saveAndComplete(h: ReturnType<typeof createHarness>, jobId: string, n = 1) {
  await h.until(() => h.saved.length === n);
  const saved = h.saved[n - 1]!;
  h.complete(saved.id);
  const ev = await h.finished(jobId);
  return { saved, ev };
}

describe("download orchestrator: chunked and segment routes (spec 6.2 rows)", () => {
  it("chunked, no engine: a 51 MB MP4 with ranges is fetched in 8 MB chunks and assembled byte for byte", async () => {
    const body = bytes(51 * MB, 7);
    const h = createHarness({ sources: [progressive("big", {}, { sizeBytes: body.byteLength })] });
    h.cdn.put("/big.mp4", { body, etag: '"big"' });
    const jobId = await h.download("big");
    const { saved, ev } = await saveAndComplete(h, jobId);
    expect(ev.t).toBe("done");
    expect(sameBytes(await bytesOf(saved.blob), body)).toBe(true);
    expect(h.backend.commands).toEqual([]); // joined without ffmpeg
    expect(h.sent[0]!.t).toBe("engine/fetch");
    expect(h.sent[1]!.t).toBe("engine/assemble");
    // every chunk request carried If-Range from the probe's ETag
    expect(h.cdn.log.filter((l) => l.range && l.range !== "bytes=0-0").every((l) => l.ifRange === '"big"')).toBe(true);
    // finished: nothing left in the chunk store or the blob registry, record done, history written
    expect(await h.store.jobs()).toEqual([]);
    expect(h.blobs.size).toBe(0);
    expect((h.area.data[jobKey(jobId)] as JobRecord).status).toBe("done");
    expect(h.history.map((e) => e.id)).toEqual([jobId]);
  });

  it("MKV remux: MP4 to MKV runs the engine with stream copy", async () => {
    const body = bytes(20 * KB);
    const h = createHarness({ sources: [progressive("m")] });
    h.cdn.put("/m.mp4", { body });
    const jobId = await h.download("m", { format: "mkv" });
    const { saved, ev } = await saveAndComplete(h, jobId);
    expect(ev).toMatchObject({ t: "done", filename: "Clip m.mkv" });
    expect(saved.filename).toBe("Clip m.mkv");
    const cmd = h.backend.commands[0]!.join(" ");
    expect(cmd).toContain("-c:v copy");
    expect(cmd.endsWith("out.mkv")).toBe(true);
    expect(sameBytes(await bytesOf(saved.blob), body)).toBe(true);
  });

  it("WEBM transcode: encodes with VP9", async () => {
    const h = createHarness({ sources: [progressive("w")] });
    h.cdn.put("/w.mp4", { body: bytes(20 * KB) });
    const jobId = await h.download("w", { format: "webm" });
    const { ev } = await saveAndComplete(h, jobId);
    expect(ev.t).toBe("done");
    expect(h.backend.commands[0]!.join(" ")).toContain("libvpx-vp9");
  });

  it("MP3: audio only through the engine", async () => {
    const h = createHarness({ sources: [progressive("s")] });
    h.cdn.put("/s.mp4", { body: bytes(20 * KB) });
    const jobId = await h.download("s", { format: "mp3", audio: "only" });
    const { saved } = await saveAndComplete(h, jobId);
    expect(saved.filename).toBe("Clip s.mp3");
    expect(h.backend.commands[0]!.join(" ")).toContain("libmp3lame");
  });

  it("Reddit-style DASH: separate video and audio tracks are fetched and muxed in one command", async () => {
    const mpdUrl = fx.MPD_URL;
    const mpd = parseMpd(fx.MPD, mpdUrl);
    const video = mpd.video.find((r) => r.id === "v2")!;
    const audio = mpd.audio[0]!;
    const h = createHarness({ files: { [mpdUrl]: fx.MPD } });
    const parts: Uint8Array[] = [];
    let seed = 1;
    for (const rep of [video, audio]) {
      for (const seg of [rep.init!, ...rep.segments]) {
        const body = bytes(2 * KB, seed++);
        parts.push(body);
        h.cdn.put(new URL(seg.url).pathname, { body });
      }
    }
    const src: VideoSource = {
      id: "reddit:1",
      site: "reddit",
      title: "Dash",
      pageUrl: "https://www.reddit.com/r/x/comments/1",
      duration: 20,
      variants: [{ id: "v2", kind: "dash", url: mpdUrl, container: "fmp4", hasAudio: false, videoCodec: "avc1.640028", height: 1080, bitrate: 3_000_000 }],
      audioTracks: [{ id: "a1", kind: "dash", url: mpdUrl, codec: "mp4a.40.2", bitrate: 128_000 }],
      protection: "none",
      detectedBy: ["adapter"],
    };
    const jobId = await h.orch.start(src, { format: "mp4", quality: "best", audio: "keep", filenameTemplate: "{title}-{resolution}" });
    const { saved, ev } = await saveAndComplete(h, jobId);
    expect(ev).toMatchObject({ t: "done", filename: "Dash-1080p.mp4" });
    const cmd = h.backend.commands[0]!;
    expect(cmd.filter((_a, i) => cmd[i - 1] === "-i")).toEqual(["in0.fmp4", "in1.fmp4"]);
    // the engine received video chunks then audio chunks, in plan order
    const want = new Uint8Array(parts.reduce((s, b) => s + b.byteLength, 0));
    let at = 0;
    for (const b of parts) {
      want.set(b, at);
      at += b.byteLength;
    }
    expect(sameBytes(await bytesOf(saved.blob), want)).toBe(true);
  });

  it("HLS TS with trim: only the segments in the window are fetched, with a seek into the first", async () => {
    const base = "https://cdn.example.org/hls/";
    const h = createHarness({ files: { [base + "720p.m3u8"]: fx.MEDIA_VOD } });
    for (const n of [0, 1, 2]) h.cdn.put(`/hls/s${n}.ts`, { body: bytes(3 * KB, n + 1) });
    const src: VideoSource = {
      id: "g:h",
      site: "generic",
      title: "Hls",
      pageUrl: "https://videos.example.org/watch/42",
      duration: 30,
      variants: [{ id: "hls:720", kind: "hls", url: base + "720p.m3u8", container: "ts", hasAudio: true, videoCodec: "avc1.64001f", audioCodec: "mp4a.40.2", height: 720 }],
      audioTracks: [],
      protection: "none",
      detectedBy: ["network"],
    };
    const jobId = await h.orch.start(src, { format: "mp4", quality: "best", audio: "keep", trim: { start: 12, end: 18 }, filenameTemplate: "{title}" });
    await saveAndComplete(h, jobId);
    expect(h.cdn.log.map((l) => l.path)).toEqual(["/hls/s1.ts"]);
    const cmd = h.backend.commands[0]!;
    expect(Number(cmd[cmd.indexOf("-ss") + 1])).toBe(2);
    expect(cmd).toContain("aac_adtstoasc");
  });
});

describe("download orchestrator: failure, cancel, queue", () => {
  it("keeps the fetched chunks and a resumable record when the network drops mid-download", async () => {
    const body = bytes(51 * MB, 3);
    const h = createHarness({ sources: [progressive("big", {}, { sizeBytes: body.byteLength })] });
    h.cdn.put("/big.mp4", { body, etag: '"e"' });
    h.cdn.failures.push((_p, n) => (n >= 5 ? "network" : undefined));
    const jobId = await h.download("big", { format: "mkv" });
    const ev = await h.finished(jobId);
    expect(ev).toMatchObject({ t: "failed", resumable: true });
    expect(ev.t === "failed" && ev.error.code).toBe("network");
    expect(ev.t === "failed" && ev.keptRatio).toBeGreaterThan(0);
    const rec = h.area.data[jobKey(jobId)] as JobRecord;
    expect(rec).toMatchObject({ status: "failed", resumable: true });
    expect(rec.tracks[0]!.committed.length).toBeGreaterThan(0);
    expect((await h.store.list(jobId, "0")).size).toBe(rec.tracks[0]!.committed.length);
    expect(h.sent.some((m) => m.t === "engine/discard")).toBe(false);
    expect(h.rules.size).toBe(0);
  });

  it("an expired link fails as expired and stays resumable", async () => {
    const h = createHarness({ sources: [progressive("e", {}, { url: "https://cdn.test/e.mp4?sig=old" })] });
    h.cdn.put("/e.mp4", { body: bytes(KB) });
    const jobId = await h.download("e", { format: "mkv" });
    const ev = await h.finished(jobId);
    expect(ev.t === "failed" && ev.error.code).toBe("expired");
    expect(ev.t === "failed" && ev.resumable).toBe(true);
  });

  it("cancel at 50 % leaves nothing in Downloads, the chunk store or the blob registry", async () => {
    const body = bytes(51 * MB, 5);
    const h = createHarness({ sources: [progressive("big", {}, { sizeBytes: body.byteLength })] });
    h.cdn.put("/big.mp4", { body });
    // probe is request 0 and chunks are 1..7; stall from the 5th chunk on, about half done
    h.setGate((_u, n) => (n >= 5 ? new Promise<void>(() => undefined) : undefined));
    const jobId = await h.download("big", { format: "mkv" });
    await h.until(() => h.events.some((e) => e.t === "progress" && e.ratio >= 0.4));
    await h.orch.cancel(jobId);
    expect(await h.finished(jobId)).toEqual({ t: "cancelled", jobId });
    expect(h.saved).toEqual([]);
    expect(await h.store.jobs()).toEqual([]);
    expect(h.blobs.size).toBe(0);
    expect(h.rules.size).toBe(0);
    expect((h.area.data[jobKey(jobId)] as JobRecord).status).toBe("cancelled");
    expect(h.sent.some((m) => m.t === "engine/discard")).toBe(true);
  });

  it("cancel while saving cancels and removes the Chrome download", async () => {
    const h = createHarness({ sources: [progressive("a")] });
    const jobId = await h.download("a");
    await h.until(() => h.saved.length === 1);
    await h.orch.cancel(jobId);
    expect(await h.finished(jobId)).toEqual({ t: "cancelled", jobId });
    expect(h.removedFiles).toEqual([1]);
    expect(h.erased).toEqual([1]);
  });

  it("runs one engine job at a time while fetches overlap", async () => {
    const h = createHarness({ sources: [progressive("a"), progressive("b")] });
    h.cdn.put("/a.mp4", { body: bytes(8 * KB, 1) });
    h.cdn.put("/b.mp4", { body: bytes(8 * KB, 2) });
    let release!: () => void;
    h.backend.hold = new Promise<void>((r) => (release = r));
    const first = await h.download("a", { format: "mkv" });
    const second = await h.download("b", { format: "mkv" });
    await h.until(() => h.sent.filter((m) => m.t === "engine/fetch").length === 2 && h.sent.some((m) => m.t === "engine/download"));
    await new Promise((r) => setTimeout(r, 30));
    const downloads = () => h.sent.filter((m) => m.t === "engine/download");
    expect(downloads().map((m) => m.jobId)).toEqual([first]); // second is fetched but waits for the engine
    release();
    await h.until(() => h.saved.length === 2);
    expect(downloads().map((m) => m.jobId)).toEqual([first, second]);
    h.complete(1);
    h.complete(2);
    expect((await h.finished(first)).t).toBe("done");
    expect((await h.finished(second)).t).toBe("done");
  });

  it("fails the jobs running on the engine when the offscreen document goes away", async () => {
    const h = createHarness({ sources: [progressive("a")] });
    h.cdn.put("/a.mp4", { body: bytes(8 * KB) });
    h.backend.hold = new Promise<void>(() => undefined);
    const jobId = await h.download("a", { format: "mkv" });
    await h.until(() => h.sent.some((m) => m.t === "engine/download"));
    await h.orch.onEngineDisconnect();
    const ev = await h.finished(jobId);
    expect(ev).toMatchObject({ t: "failed", resumable: true });
  });
});
