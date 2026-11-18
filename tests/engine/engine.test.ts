import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDownloadArgs, buildGifArgs, type EngineInput } from '../../src/core/ffmpeg-args';
import type { DownloadOptions, Variant, VideoSource } from '../../src/core/model';
import { planDownload } from '../../src/core/plan';
import { Engine } from '../../src/offscreen/engine';
import { NodeBackend } from '../helpers/node-backend';

const backend = new NodeBackend();
const engine = new Engine(backend);
const noProgress = () => {};
const live = new AbortController().signal;

const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const ascii = (u: Uint8Array, from: number, len: number) =>
  String.fromCharCode(...u.slice(from, from + len));
/** ISO-BMFF: "ftyp" at offset 4. */
const isMp4 = (u: Uint8Array) => ascii(u, 4, 4) === 'ftyp';
/** Movie duration in seconds from the mvhd box. */
function mp4Duration(u: Uint8Array): number {
  const at = ascii(u, 0, u.length).indexOf('mvhd');
  const v = new DataView(u.buffer, u.byteOffset + at + 4 + 4 + 8);
  return v.getUint32(4) / v.getUint32(0);
}

function source(v: Partial<Variant>, audioTracks: VideoSource['audioTracks'] = []): VideoSource {
  return {
    id: 's',
    site: 'generic',
    title: 't',
    pageUrl: 'https://p.test/',
    duration: 2,
    variants: [
      {
        id: 'v0',
        kind: 'progressive',
        url: 'https://c.test/v.mp4',
        container: 'mp4',
        hasAudio: true,
        ...v,
      },
    ],
    audioTracks,
    protection: 'none',
    detectedBy: ['network'],
  };
}
const opts = (o: Partial<DownloadOptions> = {}): DownloadOptions => ({
  format: 'mp4',
  quality: 'best',
  audio: 'keep',
  filenameTemplate: '{title}',
  ...o,
});

/** Plan → write the blobs under plan-order names → run the real download command line. */
async function download(
  src: VideoSource,
  o: DownloadOptions,
  blobs: Blob[],
  seeks?: { start: number; length: number }[],
) {
  const plan = planDownload(src, o);
  const inputs: EngineInput[] = plan.inputs.map((i, n) => ({
    file: `in${n}.${i.container}`,
    container: i.container,
  }));
  const out = `out.${plan.output.extension}`;
  const blob = await engine.encode(
    {
      inputs: inputs.map((i, n) => ({ name: i.file, blob: blobs[n]! })),
      commands: [buildDownloadArgs(plan, inputs, out, seeks)],
      output: out,
      mime: plan.output.mime,
    },
    noProgress,
    live,
  );
  return { plan, blob };
}

const gen = (extra: string[], output: string, mime: string) =>
  engine.encode(
    {
      inputs: [],
      commands: [
        [
          '-hide_banner',
          '-nostdin',
          '-f',
          'lavfi',
          '-i',
          'testsrc=duration=2:size=160x120:rate=15',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=2',
          ...extra,
          '-y',
          output,
        ],
      ],
      output,
      mime,
    },
    noProgress,
    live,
  );
const H264 = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'];

let clip: Blob;
beforeAll(async () => {
  clip = await gen([...H264, '-c:a', 'aac'], 'clip.mp4', 'video/mp4');
}, 120_000);
afterAll(() => backend.terminate());

describe('engine: download pipeline', () => {
  it('remuxes MP4 to MKV with stream copy', async () => {
    const { blob } = await download(
      source({ videoCodec: 'avc1', audioCodec: 'mp4a.40.2' }),
      opts({ format: 'mkv' }),
      [clip],
    );
    expect(Array.from((await bytes(blob)).slice(0, 4))).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
    expect(blob.type).toBe('video/x-matroska');
  }, 120_000);

  it('muxes a DASH video-only + audio-only pair into one MP4', async () => {
    const video = await gen([...H264, '-an', '-f', 'mp4'], 'v.mp4', 'video/mp4');
    const audio = await gen(['-vn', '-c:a', 'aac', '-f', 'ipod'], 'a.m4a', 'audio/mp4');
    const src = source({ kind: 'dash', hasAudio: false, videoCodec: 'avc1' }, [
      { id: 'a0', kind: 'dash', url: 'https://c.test/a', codec: 'mp4a.40.2', bitrate: 128000 },
    ]);
    const { plan, blob } = await download(src, opts(), [video, audio]);
    expect(plan.inputs.map((i) => i.role)).toEqual(['video', 'audio']);
    const out = await bytes(blob);
    expect(isMp4(out)).toBe(true);
    // both streams really are in there: each can be mapped out on its own
    for (const map of ['0:v:0', '0:a:0']) {
      await engine.encode(
        {
          inputs: [{ name: 'm.mp4', blob }],
          commands: [['-i', 'm.mp4', '-map', map, '-c', 'copy', '-f', 'null', '-']],
          output: 'm.mp4',
          mime: 'video/mp4',
        },
        noProgress,
        live,
      );
    }
  }, 120_000);

  it('converts concatenated HLS TS segments to MP4 with a stream copy', async () => {
    const ts = await gen([...H264, '-c:a', 'aac', '-f', 'mpegts'], 'clip.ts', 'video/mp2t');
    // two segments' worth of bytes concatenated, as assembleTrack() does
    const half = Math.floor(ts.size / 2);
    const joined = new Blob([ts.slice(0, half - (half % 188)), ts.slice(half - (half % 188))]);
    const { plan, blob } = await download(source({ kind: 'hls', container: 'ts' }), opts(), [
      joined,
    ]);
    expect(plan).toMatchObject({ video: 'copy', audio: 'copy' });
    expect(isMp4(await bytes(blob))).toBe(true);
  }, 120_000);

  it('trims a progressive file with input seeking', async () => {
    const { blob } = await download(
      source({ videoCodec: 'avc1', audioCodec: 'mp4a.40.2' }),
      opts({ trim: { start: 0.5, end: 1.5 } }),
      [clip],
      [{ start: 0.5, length: 1 }],
    );
    const d = mp4Duration(await bytes(blob));
    expect(d).toBeGreaterThan(0.5);
    expect(d).toBeLessThan(1.6);
  }, 120_000);

  it('extracts MP3 audio', async () => {
    const { blob } = await download(
      source({ videoCodec: 'avc1', audioCodec: 'mp4a.40.2' }),
      opts({ format: 'mp3' }),
      [clip],
    );
    const u = await bytes(blob);
    expect(ascii(u, 0, 3) === 'ID3' || (u[0] === 0xff && (u[1]! & 0xe0) === 0xe0)).toBe(true);
    expect(blob.type).toBe('audio/mpeg');
  }, 120_000);

  it('renders a GIF in two passes (palette, then render)', async () => {
    const gifOpts = {
      trim: { start: 0, end: 2 },
      fps: 10,
      width: 320,
      loop: 0,
      dither: true,
    } as const;
    const cmds = buildGifArgs(
      gifOpts,
      'in.mp4',
      'out.gif',
      { width: 160, height: 120 },
      { start: 0, length: 1 },
    );
    const progress: number[] = [];
    const blob = await engine.encode(
      {
        inputs: [{ name: 'in.mp4', blob: clip }],
        commands: [cmds.pass1, cmds.pass2],
        output: 'out.gif',
        mime: 'image/gif',
        scratch: [cmds.palette],
      },
      (r) => progress.push(r),
      live,
    );
    expect(ascii(await bytes(blob), 0, 4)).toBe('GIF8');
    expect(blob.type).toBe('image/gif');
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((r) => r >= 0 && r <= 1)).toBe(true);
  }, 120_000);
});

describe('engine: cancel', () => {
  it('frees the engine when cancelled mid-encode and the next job runs', async () => {
    const loadsBefore = backend.loads;
    const ac = new AbortController();
    const slow = engine.encode(
      {
        inputs: [],
        commands: [
          [
            '-hide_banner',
            '-nostdin',
            '-f',
            'lavfi',
            '-i',
            'testsrc2=duration=900:size=1280x720:rate=30',
            '-c:v',
            'libx264',
            '-preset',
            'slower',
            '-y',
            'big.mp4',
          ],
        ],
        output: 'big.mp4',
        mime: 'video/mp4',
      },
      noProgress,
      ac.signal,
    );
    setTimeout(() => ac.abort(), 1500);
    await expect(slow).rejects.toMatchObject({ appError: { code: 'cancelled' } });

    const { blob } = await download(
      source({ videoCodec: 'avc1', audioCodec: 'mp4a.40.2' }),
      opts({ format: 'mkv' }),
      [clip],
    );
    expect(blob.size).toBeGreaterThan(0);
    // terminate() dropped the runtime; the next job loaded a fresh one
    expect(backend.loads).toBe(loadsBefore + 1);
  }, 120_000);

  it('rejects immediately for an already-aborted signal without loading', async () => {
    const ac = new AbortController();
    ac.abort();
    const before = backend.loads;
    await expect(engine.run(['-version'], noProgress, ac.signal)).rejects.toMatchObject({
      appError: { code: 'cancelled' },
    });
    expect(backend.loads).toBe(before);
  });
});
