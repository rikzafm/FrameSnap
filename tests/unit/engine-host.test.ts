import { describe, expect, it, vi } from 'vitest';
import type { EngineToWorker } from '../../src/core/engine-messages';
import { planByteChunks, type TrackPlan } from '../../src/core/jobs/chunks';
import { MemoryChunkStore, type ChunkStore } from '../../src/core/jobs/store';
import type { VideoSource } from '../../src/core/model';
import { planDownload } from '../../src/core/plan';
import type { FfmpegBackend } from '../../src/offscreen/backend';
import { Engine } from '../../src/offscreen/engine';
import { createEngineHost } from '../../src/offscreen/host';
import { FakeCdn, bytes, noSleep } from '../helpers/fake-cdn';

const KB = 1024;

/** Stands in for ffmpeg: the "output" is every input concatenated, so tests can see what was assembled. */
class FakeBackend implements FfmpegBackend {
  files = new Map<string, Uint8Array>();
  commands: string[][] = [];
  terminated = 0;
  async load() {}
  async writeFile(p: string, d: Uint8Array) {
    this.files.set(p, d);
  }
  async readFile(p: string) {
    return this.files.get(p) ?? new Uint8Array();
  }
  async deleteFile(p: string) {
    this.files.delete(p);
  }
  async exec(args: string[]) {
    this.commands.push(args);
    const inputs = args.flatMap((a, i) => (args[i - 1] === '-i' ? [a] : []));
    const out = args[args.length - 1]!;
    const parts = inputs.map((i) => this.files.get(i) ?? new Uint8Array());
    this.files.set(out, Uint8Array.from(parts.flatMap((p) => [...p])));
    return 0;
  }
  onProgress() {}
  terminate() {
    this.terminated++;
  }
}

/** A store whose writes fail the way a full OPFS does. */
class FullStore extends MemoryChunkStore {
  override async write(): Promise<void> {
    throw new DOMException('quota', 'QuotaExceededError');
  }
}

function track(url: string, size: number): TrackPlan {
  return {
    trackId: '0',
    role: 'muxed',
    container: 'mp4',
    chunks: planByteChunks(url, size, 64 * KB),
    totalBytes: size,
  };
}

function setup(opfs: ChunkStore = new MemoryChunkStore(), gate?: Promise<void>) {
  const sent: EngineToWorker[] = [];
  const cdn = new FakeCdn();
  const backend = new FakeBackend();
  const urls = new Map<string, Blob>();
  const persist = vi.fn(async () => true);
  const host = createEngineHost({
    send: (m) => sent.push(m),
    opfs: () => opfs,
    memory: new MemoryChunkStore(),
    engine: new Engine(backend),
    http: (url, init) => (gate ? gate.then(() => cdn.http(url, init)) : cdn.http(url, init)),
    blobUrls: {
      create: (b) => {
        const u = `blob:test/${urls.size}`;
        urls.set(u, b);
        return u;
      },
      revoke: (u) => void urls.delete(u),
    },
    storage: { persist, estimate: async () => ({ usage: 10, quota: 1000 }) },
    fetchTuning: { sleep: noSleep, backoffMs: 0 },
  });
  return {
    host,
    sent,
    cdn,
    backend,
    urls,
    persist,
    of: <T extends EngineToWorker['t']>(t: T) =>
      sent.filter((m): m is Extract<EngineToWorker, { t: T }> => m.t === t),
  };
}

const src = (): VideoSource => ({
  id: 's',
  site: 'generic',
  title: 't',
  pageUrl: 'https://p.test/',
  variants: [
    {
      id: 'v0',
      kind: 'progressive',
      url: 'https://cdn.test/v.mp4',
      container: 'mp4',
      hasAudio: true,
      videoCodec: 'avc1',
      audioCodec: 'mp4a.40.2',
    },
  ],
  audioTracks: [],
  protection: 'none',
  detectedBy: ['network'],
});

describe('engine host', () => {
  it('on connect asks for persistent storage once and reports the estimate', async () => {
    const { host, persist, of } = setup();
    await host.connect();
    await host.connect();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(of('engine/ready').at(-1)).toEqual({
      t: 'engine/ready',
      storage: { usage: 10, quota: 1000, persisted: true },
    });
  });

  it('answers a status request with the jobs it is still fetching', async () => {
    let release!: () => void;
    const { host, cdn, of } = setup(new MemoryChunkStore(), new Promise<void>((r) => (release = r)));
    cdn.put('/v.mp4', { body: bytes(200 * KB), etag: '"e"' });
    await host.handle({ t: 'engine/status' });
    expect(of('engine/running').at(-1)).toEqual({ t: 'engine/running', jobs: [] });

    const fetching = host.handle({ t: 'engine/fetch', jobId: 'live', tracks: [track('https://cdn.test/v.mp4', 200 * KB)] });
    await host.handle({ t: 'engine/status' });
    expect(of('engine/running').at(-1)).toEqual({ t: 'engine/running', jobs: [{ jobId: 'live', phase: 'fetch' }] });

    release();
    await fetching;
    await host.handle({ t: 'engine/status' });
    expect(of('engine/running').at(-1)).toEqual({ t: 'engine/running', jobs: [] });
  });

  it('fetches into the store, reporting each commit and progress, resumable', async () => {
    const { host, cdn, sent, of } = setup();
    cdn.put('/v.mp4', { body: bytes(200 * KB), etag: '"e"' });
    await host.handle({
      t: 'engine/fetch',
      jobId: 'j',
      tracks: [track('https://cdn.test/v.mp4', 200 * KB)],
    });
    expect(of('engine/commit')).toHaveLength(4);
    expect(of('engine/commit')[0]).toMatchObject({
      jobId: 'j',
      trackId: '0',
      key: 'r0-65535',
      bytes: 65536,
    });
    const progress = of('engine/progress').map((m) => m.ratio);
    expect(progress.at(-1)).toBe(1);
    expect(sent.at(-1)).toEqual({ t: 'engine/fetched', jobId: 'j', resumable: true });
  });

  it('falls back to memory when the OPFS store errors, and reports not resumable', async () => {
    const { host, cdn, of } = setup(new FullStore());
    const body = bytes(200 * KB);
    cdn.put('/v.mp4', { body });
    await host.handle({
      t: 'engine/fetch',
      jobId: 'j',
      tracks: [track('https://cdn.test/v.mp4', 200 * KB)],
    });
    expect(of('engine/error')).toHaveLength(0);
    expect(of('engine/fetched')).toEqual([{ t: 'engine/fetched', jobId: 'j', resumable: false }]);

    // the encode step reads from the same fallback store
    const t = track('https://cdn.test/v.mp4', 200 * KB);
    const plan = planDownload(src(), {
      format: 'mkv',
      quality: 'best',
      audio: 'keep',
      filenameTemplate: '{title}',
    });
    await host.handle({
      t: 'engine/download',
      jobId: 'j',
      plan,
      tracks: [{ trackId: '0', keys: t.chunks.map((c) => c.key) }],
      seeks: [undefined],
    });
    const result = of('engine/result')[0]!;
    expect(result.bytes).toBe(body.byteLength);
    expect(result.mime).toBe('video/x-matroska');
  });

  it('reports a non-storage failure as an error and keeps the job resumable when retryable', async () => {
    const { host, cdn, of } = setup();
    cdn.put('/v.mp4', { body: bytes(100 * KB) });
    cdn.failures.push(() => 403);
    await host.handle({
      t: 'engine/fetch',
      jobId: 'j',
      tracks: [track('https://cdn.test/v.mp4', 100 * KB)],
    });
    expect(of('engine/error')[0]).toMatchObject({
      jobId: 'j',
      error: { code: 'expired' },
      resumable: true,
    });
  });

  it('download: assembles tracks, runs ffmpeg, returns a blob: URL that revoke frees', async () => {
    const { host, cdn, backend, urls, of } = setup();
    const body = bytes(130 * KB);
    cdn.put('/v.mp4', { body });
    const t = track('https://cdn.test/v.mp4', body.byteLength);
    await host.handle({ t: 'engine/fetch', jobId: 'j', tracks: [t] });
    const plan = planDownload(src(), {
      format: 'mkv',
      quality: 'best',
      audio: 'keep',
      filenameTemplate: '{title}',
    });
    await host.handle({
      t: 'engine/download',
      jobId: 'j',
      plan,
      tracks: [{ trackId: '0', keys: t.chunks.map((c) => c.key) }],
      seeks: [undefined],
    });

    expect(backend.commands[0]).toContain('in0.mp4');
    const r = of('engine/result')[0]!;
    expect(r).toMatchObject({ jobId: 'j', mime: 'video/x-matroska', bytes: body.byteLength });
    expect(urls.has(r.url)).toBe(true);
    await host.handle({ t: 'engine/revoke', url: r.url });
    expect(urls.has(r.url)).toBe(false);
  });

  it('gif: runs the palette pass then the render pass', async () => {
    const { host, cdn, backend, of } = setup();
    cdn.put('/v.mp4', { body: bytes(70 * KB) });
    const t = track('https://cdn.test/v.mp4', 70 * KB);
    await host.handle({ t: 'engine/fetch', jobId: 'j', tracks: [t] });
    await host.handle({
      t: 'engine/gif',
      jobId: 'j',
      options: { trim: { start: 0, end: 2 }, fps: 10, width: 320, loop: 0, dither: true },
      src: { width: 640, height: 360 },
      track: { trackId: '0', keys: t.chunks.map((c) => c.key), container: 'mp4' },
      seek: { start: 0, length: 2 },
    });
    expect(backend.commands).toHaveLength(2);
    expect(backend.commands[0]!.join(' ')).toContain('palettegen');
    expect(backend.commands[1]!.join(' ')).toContain('paletteuse');
    expect(of('engine/result')[0]).toMatchObject({ mime: 'image/gif' });
  });

  it("cancel aborts the job's work, kills ffmpeg and reports cancelled", async () => {
    const { host, cdn, backend, of } = setup();
    cdn.put('/v.mp4', { body: bytes(600 * KB) });
    const running = host.handle({
      t: 'engine/fetch',
      jobId: 'j',
      tracks: [track('https://cdn.test/v.mp4', 600 * KB)],
    });
    await host.handle({ t: 'engine/cancel', jobId: 'j' });
    await running;
    expect(of('engine/error')[0]).toMatchObject({ jobId: 'j', error: { code: 'cancelled' } });
    expect(of('engine/fetched')).toHaveLength(0);
    void backend;
  });

  it("assemble joins the chunks into one blob of the given type without running ffmpeg", async () => {
    const { host, cdn, backend, urls, of } = setup();
    const body = bytes(200 * KB);
    cdn.put('/v.mp4', { body });
    const t = track('https://cdn.test/v.mp4', 200 * KB);
    await host.handle({ t: 'engine/fetch', jobId: 'j', tracks: [t] });
    await host.handle({
      t: 'engine/assemble',
      jobId: 'j',
      mime: 'video/mp4',
      tracks: [{ trackId: '0', keys: t.chunks.map((c) => c.key) }],
    });
    const res = of('engine/result')[0]!;
    expect(res).toMatchObject({ jobId: 'j', bytes: 200 * KB, mime: 'video/mp4' });
    expect(new Uint8Array(await urls.get(res.url)!.arrayBuffer())).toEqual(body);
    expect(backend.commands).toEqual([]);
  });

  it("discard deletes the job's chunks", async () => {
    const store = new MemoryChunkStore();
    const { host, cdn } = setup(store);
    cdn.put('/v.mp4', { body: bytes(70 * KB) });
    await host.handle({
      t: 'engine/fetch',
      jobId: 'j',
      tracks: [track('https://cdn.test/v.mp4', 70 * KB)],
    });
    expect((await store.jobs()).map((j) => j.jobId)).toEqual(['j']);
    await host.handle({ t: 'engine/discard', jobId: 'j' });
    expect(await store.jobs()).toEqual([]);
  });
});
