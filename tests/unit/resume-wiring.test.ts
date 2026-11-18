/**
 * Resume wiring at the orchestrator seam: startup recovery, re-detect and
 * match, decide, continue / restart / pick, discard and cleanup. Bytes come
 * from the fake CDN through the real engine host, so "only the missing
 * ranges are fetched" is read off the CDN log.
 */
import { describe, expect, it } from "vitest";
import { jobKey } from "../../src/background/job-store";
import type { JobRecord } from "../../src/core/jobs/job";
import { parseMpd } from "../../src/core/media/dash";
import type { VideoSource } from "../../src/core/model";
import * as fx from "../fixtures/hls-page";
import { bytes, sameBytes } from "../helpers/fake-cdn";
import { createHarness, progressive, type Harness } from "../helpers/orchestrator-harness";

const KB = 1024;
const MB = 1024 * KB;
const DAY = 24 * 60 * 60 * 1000;

const bytesOf = async (b: Blob | undefined) => new Uint8Array(await b!.arrayBuffer());
const rec = (h: Harness, id: string) => h.area.data[jobKey(id)] as JobRecord | undefined;
const chunkRequests = (h: Harness, path: string) => h.cdn.log.filter((l) => l.path === path && l.range && l.range !== "bytes=0-0");

/** A page whose current detection result the test controls (a reload swaps it). */
function page(initial: VideoSource[], pageUrl = "https://p.test/watch") {
  const state = { sources: initial, urls: new Map<number, string | undefined>(), opened: [] as string[] };
  return {
    state,
    deps: {
      listSources: async () => state.sources,
      tabUrl: async (tabId: number) => (tabId === 1 ? (state.urls.get(1) ?? pageUrl) : state.urls.get(tabId)),
      openTab: async (url: string) => {
        state.opened.push(url);
        return 99;
      },
      settleMs: 0,
      sleep: async () => undefined,
    },
  };
}

const big = (sig: string, over: Partial<VideoSource> = {}) => progressive("big", over, { url: `https://cdn.test/big.mp4?sig=${sig}`, sizeBytes: 51 * MB });

async function saveAndComplete(h: Harness, jobId: string, n = 1) {
  await h.until(() => h.saved.length === n);
  const saved = h.saved[n - 1]!;
  h.complete(saved.id);
  await h.until(() => h.events.some((e) => e.jobId === jobId && e.t === "done"));
  return { saved, ev: h.events.find((e) => e.jobId === jobId && e.t === "done")! };
}

/** Progress events and the terminal event of the run that started after `from`. */
const after = (h: Harness, jobId: string, from: number) => h.events.slice(from).filter((e) => e.jobId === jobId);

describe("resume: progressive (chunked)", () => {
  it("after a failure at 50 % and a reload with new signed URLs, fetches only the missing ranges and the output equals an uninterrupted run", async () => {
    const body = bytes(51 * MB, 3);
    const p = page([]);
    const h = createHarness({ sources: [big("s1")], deps: p.deps });
    h.cdn.put("/big.mp4", { body, etag: '"e"' });
    for (const s of ["s1", "s2"]) h.cdn.validSigs.add(s);
    h.cdn.validSigs.add("s1");
    h.cdn.failures.push((_p, n) => (n >= 5 ? "network" : undefined));

    const jobId = await h.download("big", { format: "mkv" });
    expect((await h.finished(jobId)).t).toBe("failed");
    const kept = rec(h, jobId)!.tracks[0]!.committed.length;
    expect(kept).toBeGreaterThan(0);

    // reload: signed URL rotated, the network is back
    h.cdn.failures.length = 0;
    h.cdn.validSigs.clear();
    h.cdn.validSigs.add("s2");
    p.state.sources = [big("s2")];
    h.cdn.log.length = 0;
    const from = h.events.length;

    await h.orch.resume(jobId, 1);
    const { saved, ev } = await saveAndComplete(h, jobId);
    expect(ev.t).toBe("done");
    const total = rec(h, jobId)!.tracks[0]!.keys.length;
    expect(chunkRequests(h, "/big.mp4")).toHaveLength(total - kept);
    expect(sameBytes(await bytesOf(saved.blob), body)).toBe(true);
    expect(after(h, jobId, from).some((e) => e.t === "progress")).toBe(true);
    expect(await h.store.jobs()).toEqual([]);
  });

  it("restarts with the 'changed' notice when the ETag differs", async () => {
    const oldBody = bytes(51 * MB, 3);
    const newBody = bytes(51 * MB, 9);
    const p = page([]);
    const h = createHarness({ sources: [big("s1")], deps: p.deps });
    h.cdn.put("/big.mp4", { body: oldBody, etag: '"v1"' });
    for (const s of ["s1", "s2"]) h.cdn.validSigs.add(s);
    h.cdn.failures.push((_p, n) => (n >= 5 ? "network" : undefined));
    const jobId = await h.download("big", { format: "mkv" });
    await h.finished(jobId);
    expect(rec(h, jobId)!.tracks[0]!.committed.length).toBeGreaterThan(0);

    h.cdn.failures.length = 0;
    h.cdn.put("/big.mp4", { body: newBody, etag: '"v2"' });
    for (const s of ["s1", "s2"]) h.cdn.validSigs.add(s);
    p.state.sources = [big("s2")];
    h.cdn.log.length = 0;

    await h.orch.resume(jobId, 1);
    const { saved } = await saveAndComplete(h, jobId);
    expect(h.events).toContainEqual({ t: "notice", jobId, code: "changed" });
    expect(h.sent.some((m) => m.t === "engine/fetch" && m.fresh === true)).toBe(true);
    expect(chunkRequests(h, "/big.mp4")).toHaveLength(rec(h, jobId)!.tracks[0]!.keys.length);
    expect(sameBytes(await bytesOf(saved.blob), newBody)).toBe(true);
  });

  it("two same-length videos: asks for a pick, then continues with the picked one", async () => {
    const body = bytes(51 * MB, 4);
    const p = page([]);
    const mk = (id: string, sig: string) => progressive(id, { id, duration: 10, site: "generic" }, { id: "x", url: `https://cdn.test/big.mp4?sig=${sig}`, sizeBytes: 51 * MB });
    const h = createHarness({ sources: [mk("old", "s1")], deps: p.deps });
    h.cdn.put("/big.mp4", { body, etag: '"e"' });
    for (const s of ["s1", "s2"]) h.cdn.validSigs.add(s);
    h.cdn.failures.push((_p, n) => (n >= 5 ? "network" : undefined));
    const jobId = await h.download("old", { format: "mkv" });
    await h.finished(jobId);
    const kept = rec(h, jobId)!.tracks[0]!.committed.length;

    h.cdn.failures.length = 0;
    // after the reload the ids changed and a second video of the same length is on the page
    const a = mk("new-a", "s2");
    const b = mk("new-b", "s2");
    p.state.sources = [a, b];
    h.cdn.log.length = 0;

    await h.orch.resume(jobId, 1);
    expect(h.events).toContainEqual({ t: "resume-needs-pick", jobId });
    expect(h.cdn.log).toEqual([]);
    expect(rec(h, jobId)).toMatchObject({ status: "failed", resumable: true });

    await h.orch.resumePicked(jobId, 1, b);
    const { saved, ev } = await saveAndComplete(h, jobId);
    expect(ev.t).toBe("done");
    expect(chunkRequests(h, "/big.mp4")).toHaveLength(rec(h, jobId)!.tracks[0]!.keys.length - kept);
    expect(sameBytes(await bytesOf(saved.blob), body)).toBe(true);
  });

  it("goes straight to the engine when every chunk was already fetched", async () => {
    const body = bytes(51 * MB, 6);
    const p = page([big("s1")]);
    const h = createHarness({ sources: [big("s1")], deps: p.deps });
    h.cdn.put("/big.mp4", { body, etag: '"e"' });
    for (const s of ["s1", "s2"]) h.cdn.validSigs.add(s);
    let release!: () => void;
    h.backend.hold = new Promise<void>((r) => (release = r));
    const jobId = await h.download("big", { format: "mkv" });
    await h.until(() => h.sent.some((m) => m.t === "engine/download"));
    await h.orch.onEngineDisconnect(); // the converter died after the last chunk
    expect(rec(h, jobId)).toMatchObject({ status: "failed", resumable: true });
    release();
    h.backend.hold = undefined;
    h.cdn.log.length = 0;
    h.sent.length = 0;

    p.state.sources = [big("s2")];
    await h.orch.resume(jobId, 1);
    const { saved } = await saveAndComplete(h, jobId);
    expect(h.sent.map((m) => m.t)).not.toContain("engine/fetch");
    expect(chunkRequests(h, "/big.mp4")).toEqual([]);
    expect(sameBytes(await bytesOf(saved.blob), body)).toBe(true);
  });
});

describe("resume: manifests", () => {
  const hlsSource = (): VideoSource => ({
    id: "g:h",
    site: "generic",
    title: "Hls",
    pageUrl: "https://videos.example.org/watch/42",
    duration: 30,
    variants: [{ id: "hls:720", kind: "hls", url: "https://cdn.example.org/hls/720p.m3u8", container: "ts", hasAudio: true, videoCodec: "avc1.64001f", audioCodec: "mp4a.40.2", height: 720 }],
    audioTracks: [],
    protection: "none",
    detectedBy: ["network"],
  });

  it("HLS: only the missing segments are fetched", async () => {
    const p = page([hlsSource()], "https://videos.example.org/watch/42");
    const h = createHarness({ sources: [hlsSource()], files: { "https://cdn.example.org/hls/720p.m3u8": fx.MEDIA_VOD }, deps: p.deps });
    const parts = [1, 2, 3].map((n) => bytes(3 * KB, n));
    parts.forEach((body, n) => h.cdn.put(`/hls/s${n}.ts`, { body }));
    let healed = false;
    h.cdn.failures.push((path) => (path === "/hls/s2.ts" && !healed ? "network" : undefined));
    const jobId = await h.download("g:h");
    expect((await h.finished(jobId)).t).toBe("failed");
    expect(rec(h, jobId)!.tracks[0]!.committed).toEqual(["s0", "s1"]);

    healed = true;
    h.cdn.log.length = 0;
    await h.orch.resume(jobId, 1);
    const { saved } = await saveAndComplete(h, jobId);
    expect(h.cdn.log.map((l) => l.path)).toEqual(["/hls/s2.ts"]);
    expect(sameBytes(await bytesOf(saved.blob), Uint8Array.from(parts.flatMap((x) => [...x])))).toBe(true);
  });

  it("DASH video + audio pair: only the missing segments of each track are fetched", async () => {
    const mpdUrl = fx.MPD_URL;
    const mpd = parseMpd(fx.MPD, mpdUrl);
    const video = mpd.video.find((r) => r.id === "v2")!;
    const audio = mpd.audio[0]!;
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
    const p = page([src], "https://www.reddit.com/r/x/comments/1");
    const h = createHarness({ sources: [src], files: { [mpdUrl]: fx.MPD }, deps: p.deps });
    const parts: Uint8Array[] = [];
    let seed = 1;
    const lastAudio = new URL(audio.segments[audio.segments.length - 1]!.url).pathname;
    for (const rep of [video, audio]) {
      for (const seg of [rep.init!, ...rep.segments]) {
        const body = bytes(2 * KB, seed++);
        parts.push(body);
        h.cdn.put(new URL(seg.url).pathname, { body });
      }
    }
    let healed = false;
    h.cdn.failures.push((path) => (path === lastAudio && !healed ? "network" : undefined));
    const jobId = await h.orch.start(src, { format: "mp4", quality: "best", audio: "keep", filenameTemplate: "{title}" });
    expect((await h.finished(jobId)).t).toBe("failed");

    healed = true;
    h.cdn.log.length = 0;
    await h.orch.resume(jobId, 1);
    const { saved } = await saveAndComplete(h, jobId);
    expect(h.cdn.log.map((l) => l.path)).toEqual([lastAudio]);
    expect(sameBytes(await bytesOf(saved.blob), Uint8Array.from(parts.flatMap((x) => [...x])))).toBe(true);
  });
});

describe("resume: entry points", () => {
  it("opens the job's page in a new tab when the tab is gone, then resumes there", async () => {
    const p = page([]);
    const h = createHarness({ sources: [big("s1")], deps: p.deps });
    h.cdn.put("/big.mp4", { body: bytes(51 * MB, 3), etag: '"e"' });
    for (const s of ["s1", "s2"]) h.cdn.validSigs.add(s);
    h.cdn.failures.push((_p, n) => (n >= 5 ? "network" : undefined));
    const jobId = await h.download("big", { format: "mkv" });
    await h.finished(jobId);
    h.cdn.failures.length = 0;
    p.state.sources = [big("s2")];

    await h.orch.resume(jobId, 7); // tab 7 does not exist
    expect(p.state.opened).toEqual(["https://p.test/watch"]);
    expect((await saveAndComplete(h, jobId)).ev.t).toBe("done");
  });

  it("does not open a tab when the current tab already shows the page", async () => {
    const p = page([]);
    const h = createHarness({ sources: [big("s1")], deps: p.deps });
    h.cdn.put("/big.mp4", { body: bytes(51 * MB, 3), etag: '"e"' });
    for (const s of ["s1", "s2"]) h.cdn.validSigs.add(s);
    h.cdn.failures.push((_p, n) => (n >= 5 ? "network" : undefined));
    const jobId = await h.download("big", { format: "mkv" });
    await h.finished(jobId);
    h.cdn.failures.length = 0;
    p.state.sources = [big("s2")];
    p.state.urls.set(1, "https://www.p.test/watch#t=3");

    await h.orch.resume(jobId, 1);
    expect(p.state.opened).toEqual([]);
    expect((await saveAndComplete(h, jobId)).ev.t).toBe("done");
  });

  it("discard removes the chunks and the record", async () => {
    const p = page([]);
    const h = createHarness({ sources: [big("s1")], deps: p.deps });
    h.cdn.put("/big.mp4", { body: bytes(51 * MB, 3), etag: '"e"' });
    for (const s of ["s1", "s2"]) h.cdn.validSigs.add(s);
    h.cdn.failures.push((_p, n) => (n >= 5 ? "network" : undefined));
    const jobId = await h.download("big", { format: "mkv" });
    await h.finished(jobId);
    expect((await h.store.jobs()).length).toBe(1);

    await h.orch.discard(jobId);
    expect(await h.store.jobs()).toEqual([]);
    expect(rec(h, jobId)).toBeUndefined();
  });
});

describe("startup recovery and cleanup", () => {
  it("recover turns jobs left running into resumable failures", async () => {
    const h = createHarness({ sources: [big("s1")] });
    h.cdn.put("/big.mp4", { body: bytes(51 * MB, 3), etag: '"e"' });
    for (const s of ["s1", "s2"]) h.cdn.validSigs.add(s);
    h.setGate((_u, n) => (n >= 5 ? new Promise<void>(() => undefined) : undefined));
    const jobId = await h.download("big", { format: "mkv" });
    await h.until(() => h.events.some((e) => e.t === "progress" && e.ratio >= 0.4));
    expect(rec(h, jobId)!.status).toBe("running");

    // a record left behind by a service worker that died (nothing is running it here)
    h.area.data[jobKey("ghost")] = { ...rec(h, jobId)!, id: "ghost" };

    await h.orch.recover();
    expect(rec(h, "ghost")).toMatchObject({ status: "failed", resumable: true });
    expect(rec(h, "ghost")!.error?.code).toBe("network");
    expect(rec(h, jobId)!.status).toBe("running"); // the live one is untouched
  });

  it("sweep drops chunks of jobs older than 7 days, their records, and chunks with no record", async () => {
    const h = createHarness({ sources: [big("s1")] });
    h.cdn.put("/big.mp4", { body: bytes(51 * MB, 3), etag: '"e"' });
    for (const s of ["s1", "s2"]) h.cdn.validSigs.add(s);
    h.cdn.failures.push((_p, n) => (n >= 5 ? "network" : undefined));
    const jobId = await h.download("big", { format: "mkv" });
    await h.finished(jobId);
    await h.store.write("orphan", "0", "k", new Uint8Array(4));
    expect((await h.store.jobs()).map((j) => j.jobId).sort()).toEqual([jobId, "orphan"].sort());

    // fresh enough: only the orphan goes
    await h.orch.sweep(rec(h, jobId)!.updatedAt + DAY);
    expect((await h.store.jobs()).map((j) => j.jobId)).toEqual([jobId]);
    expect(rec(h, jobId)).toBeDefined();

    await h.orch.sweep(rec(h, jobId)!.updatedAt + 8 * DAY);
    expect(await h.store.jobs()).toEqual([]);
    expect(rec(h, jobId)).toBeUndefined();
  });
});
