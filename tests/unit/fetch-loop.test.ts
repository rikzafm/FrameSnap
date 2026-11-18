import { describe, expect, it } from "vitest";
import { planByteChunks, planHlsChunks, bytesToHex, type TrackPlan } from "../../src/core/jobs/chunks";
import { runFetchPhase } from "../../src/core/jobs/fetch-loop";
import { MemoryChunkStore, assembleTrack } from "../../src/core/jobs/store";
import { FrameSnapError } from "../../src/core/errors";
import { parseMedia } from "../../src/core/media/hls";
import { FakeCdn, bytes, noSleep, sameBytes } from "../helpers/fake-cdn";

const KB = 1024;

function progressiveTrack(url: string, size: number, chunk = 64 * KB): TrackPlan {
  return { trackId: "0", role: "muxed", container: "mp4", chunks: planByteChunks(url, size, chunk), totalBytes: size };
}

async function blobBytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

describe("runFetchPhase", () => {
  it("downloads every chunk and the assembled track equals the file", async () => {
    const body = bytes(300 * KB);
    const cdn = new FakeCdn().put("/v.mp4", { body, etag: '"a1"' });
    const store = new MemoryChunkStore();
    const track = progressiveTrack("https://cdn.test/v.mp4", body.byteLength);

    const res = await runFetchPhase({ jobId: "j", tracks: [track], store, http: cdn.http, signal: new AbortController().signal, sleep: noSleep });

    expect(res.fetchedChunks).toBe(5);
    const out = await assembleTrack(store, "j", "0", track.chunks.map((c) => c.key));
    expect(sameBytes(await blobBytes(out), body)).toBe(true);
  });

  it("reports bytes held and the known total as bodies stream in", async () => {
    const body = bytes(200 * KB);
    const cdn = new FakeCdn().put("/v.mp4", { body, etag: '"a1"' });
    const track = progressiveTrack("https://cdn.test/v.mp4", body.byteLength);
    const seen: { bytes: number; total: number | undefined }[] = [];
    await runFetchPhase({ jobId: "j", tracks: [track], store: new MemoryChunkStore(), http: cdn.http, signal: new AbortController().signal, sleep: noSleep, onBytes: (b, total) => seen.push({ bytes: b, total }) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.total === body.byteLength)).toBe(true);
    expect(seen.at(-1)!.bytes).toBe(body.byteLength);
    expect(seen.every((s, i) => i === 0 || s.bytes >= seen[i - 1]!.bytes)).toBe(true);
  });

  it("starts the byte count from chunks already stored, and does not double count a retried chunk", async () => {
    const body = bytes(192 * KB, 3);
    const cdn = new FakeCdn().put("/v.mp4", { body, etag: '"e"' });
    const store = new MemoryChunkStore();
    const track = progressiveTrack("https://cdn.test/v.mp4", body.byteLength);
    await store.write("j", "0", track.chunks[0]!.key, body.slice(0, 64 * KB));
    cdn.failures.push((_p, n) => (n === 0 ? "network" : undefined));
    const seen: number[] = [];
    await runFetchPhase({ jobId: "j", tracks: [track], store, http: cdn.http, signal: new AbortController().signal, sleep: noSleep, concurrency: 1, onBytes: (b) => seen.push(b) });
    expect(seen[0]).toBe(64 * KB);
    expect(seen.at(-1)).toBe(body.byteLength);
    expect(Math.max(...seen)).toBe(body.byteLength);
  });

  it("resumes after a failure and fetches only the missing chunks", async () => {
    const body = bytes(640 * KB, 7);
    const cdn = new FakeCdn().put("/v.mp4", { body, etag: '"e"' });
    const store = new MemoryChunkStore();
    const track = progressiveTrack("https://cdn.test/v.mp4", body.byteLength);
    const validators = { "0": { etag: '"e"', contentLength: body.byteLength, layout: "x" } };

    // connection dies on the 4th request, permanently (retries exhausted)
    cdn.failures.push((_p, n) => (n >= 3 ? "network" : undefined));
    await expect(
      runFetchPhase({ jobId: "j", tracks: [track], store, http: cdn.http, validators, signal: new AbortController().signal, sleep: noSleep, concurrency: 1, retries: 1 }),
    ).rejects.toBeInstanceOf(TypeError);
    const kept = (await store.list("j", "0")).size;
    expect(kept).toBe(3);

    cdn.failures = [];
    cdn.log = [];
    const res = await runFetchPhase({ jobId: "j", tracks: [track], store, http: cdn.http, validators, signal: new AbortController().signal, sleep: noSleep });
    expect(res.fetchedChunks).toBe(10 - kept);
    expect(cdn.bytesServed()).toBe(body.byteLength - kept * 64 * KB);
    expect(cdn.log.every((l) => l.ifRange === '"e"')).toBe(true);
    expect(sameBytes(await blobBytes(await assembleTrack(store, "j", "0", track.chunks.map((c) => c.key))), body)).toBe(true);
  });

  it("stops with 'changed' when If-Range sees a different file", async () => {
    const cdn = new FakeCdn().put("/v.mp4", { body: bytes(128 * KB), etag: '"new"' });
    const track = progressiveTrack("https://cdn.test/v.mp4", 128 * KB);
    const err = await runFetchPhase({
      jobId: "j",
      tracks: [track],
      store: new MemoryChunkStore(),
      http: cdn.http,
      validators: { "0": { etag: '"old"', contentLength: 128 * KB, layout: "x" } },
      signal: new AbortController().signal,
      sleep: noSleep,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(FrameSnapError);
    expect((err as FrameSnapError).appError.code).toBe("changed");
  });

  it("does not retry an expired signed URL", async () => {
    const cdn = new FakeCdn().put("/v.mp4", { body: bytes(64 * KB) });
    const track = progressiveTrack("https://cdn.test/v.mp4?sig=old", 64 * KB);
    const err = await runFetchPhase({ jobId: "j", tracks: [track], store: new MemoryChunkStore(), http: cdn.http, signal: new AbortController().signal, sleep: noSleep }).catch((e) => e);
    expect((err as FrameSnapError).appError.code).toBe("expired");
    expect(cdn.log).toHaveLength(1);
  });

  it("retries transient 503s with backoff", async () => {
    const body = bytes(64 * KB);
    const cdn = new FakeCdn().put("/v.mp4", { body });
    cdn.failures.push((_p, n) => (n < 2 ? 503 : undefined));
    const waits: number[] = [];
    await runFetchPhase({
      jobId: "j",
      tracks: [progressiveTrack("https://cdn.test/v.mp4", body.byteLength)],
      store: new MemoryChunkStore(),
      http: cdn.http,
      signal: new AbortController().signal,
      backoffMs: 100,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(waits).toEqual([100, 200]);
  });

  it("trusts the store over the job record (chunk written, record not saved)", async () => {
    const body = bytes(128 * KB);
    const cdn = new FakeCdn().put("/v.mp4", { body });
    const store = new MemoryChunkStore();
    const track = progressiveTrack("https://cdn.test/v.mp4", body.byteLength);
    await store.write("j", "0", track.chunks[0]!.key, body.slice(0, 64 * KB));
    // a wrong-size leftover is refetched
    await store.write("j", "0", track.chunks[1]!.key, new Uint8Array(10));

    const res = await runFetchPhase({ jobId: "j", tracks: [track], store, http: cdn.http, signal: new AbortController().signal, sleep: noSleep });
    expect(res.fetchedChunks).toBe(1);
    expect(sameBytes(await blobBytes(await assembleTrack(store, "j", "0", track.chunks.map((c) => c.key))), body)).toBe(true);
  });

  it("cancels promptly and keeps what was committed", async () => {
    const body = bytes(640 * KB);
    const cdn = new FakeCdn().put("/v.mp4", { body });
    const store = new MemoryChunkStore();
    const ac = new AbortController();
    const err = await runFetchPhase({
      jobId: "j",
      tracks: [progressiveTrack("https://cdn.test/v.mp4", body.byteLength)],
      store,
      http: cdn.http,
      signal: ac.signal,
      concurrency: 1,
      sleep: noSleep,
      onCommit: () => {
        if ((cdn.log.length) === 2) ac.abort(new DOMException("Aborted", "AbortError"));
      },
    }).catch((e) => e);
    expect((err as DOMException).name).toBe("AbortError");
    expect((await store.list("j", "0")).size).toBe(2);
  });

  it("decrypts HLS AES-128 segments", async () => {
    const keyBytes = bytes(16, 3);
    const plain = bytes(1000, 5);
    const iv = new Uint8Array(16);
    iv[15] = 7; // sequence 7
    const key = await crypto.subtle.importKey("raw", keyBytes as Uint8Array<ArrayBuffer>, "AES-CBC", false, ["encrypt"]);
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, plain as Uint8Array<ArrayBuffer>));

    const cdn = new FakeCdn().put("/k.bin", { body: keyBytes }).put("/s7.ts", { body: cipher });
    const media = parseMedia(
      ["#EXTM3U", "#EXT-X-TARGETDURATION:4", "#EXT-X-MEDIA-SEQUENCE:7", '#EXT-X-KEY:METHOD=AES-128,URI="k.bin"', "#EXTINF:4,", "s7.ts", "#EXT-X-ENDLIST"].join("\n"),
      "https://cdn.test/p.m3u8",
    );
    const chunks = planHlsChunks(media.segments);
    expect(chunks[0]!.decrypt?.ivHex).toBe(bytesToHex(iv));

    const store = new MemoryChunkStore();
    await runFetchPhase({ jobId: "j", tracks: [{ trackId: "0", role: "muxed", container: "ts", chunks }], store, http: cdn.http, signal: new AbortController().signal, sleep: noSleep });
    expect(sameBytes(await blobBytes(await store.read("j", "0", "s7")), plain)).toBe(true);
  });
});
