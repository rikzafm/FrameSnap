import { describe, expect, it } from 'vitest';
import {
  finalizeWebm,
  finalizeWebmBytes,
  webmDurationSec,
  type WebmPart,
} from '../../src/core/webm';

// ---- a tiny MediaRecorder-shaped WebM: unknown-size Segment and Clusters, no Duration, no Cues

const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const id = (n: number) => {
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
};
const el = (i: number, payload: number[]) => {
  if (payload.length > 126) throw new Error('test payload too long');
  return [...id(i), 0x80 | payload.length, ...payload];
};
const uint = (i: number, v: number) => el(i, v < 256 ? [v] : [v >> 8, v & 0xff]);
/** SimpleBlock: track VINT, int16 relative time, flags, one payload byte. */
const block = (track: number, rel: number, key: boolean) =>
  el(0xa3, [0x80 | track, (rel >> 8) & 0xff, rel & 0xff, key ? 0x80 : 0, 0x00]);
const cluster = (tc: number, blocks: number[][]) => [
  ...id(0x1f43b675),
  ...UNKNOWN,
  ...uint(0xe7, tc),
  ...blocks.flat(),
];

const header = el(0x1a45dfa3, [...el(0x4282, [...new TextEncoder().encode('webm')])]);
const info = el(0x1549a966, [...el(0x2ad7b1, [0x0f, 0x42, 0x40]), ...el(0x4d80, [0x43])]); // 1 ms scale, MuxingApp "C"
const tracks = el(0x1654ae6b, [
  ...el(0xae, [...uint(0xd7, 1), ...uint(0x83, 1)]),
  ...el(0xae, [...uint(0xd7, 2), ...uint(0x83, 2)]),
]);

function recording(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([
    ...header,
    ...id(0x18538067),
    ...UNKNOWN,
    ...info,
    ...tracks,
    ...cluster(0, [
      block(1, 0, true),
      block(2, 0, true),
      block(1, 33, false),
      block(2, 20, true),
      block(1, 66, false),
    ]),
    ...cluster(1000, [
      block(1, 0, true),
      block(2, 0, true),
      block(1, 33, false),
      block(1, 66, false),
    ]),
  ]);
}

function join(src: Uint8Array, parts: WebmPart[]): Uint8Array<ArrayBuffer> {
  const chunks = parts.map((p) => (p instanceof Uint8Array ? p : src.subarray(p.from, p.to)));
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

describe('finalizeWebmBytes', () => {
  it('writes the duration: last frame time plus one frame of its track', () => {
    const src = recording();
    expect(webmDurationSec(src)).toBeUndefined();
    const plan = finalizeWebmBytes(src)!;
    // video ends at 1066 ms, plus its 33 ms frame gap
    expect(plan.durationSec).toBeCloseTo(1.099, 6);
    expect(webmDurationSec(join(src, plan.parts))).toBeCloseTo(1.099, 6);
  });

  it("indexes one cue per cluster on the video track, at the cluster's position", () => {
    const src = recording();
    const plan = finalizeWebmBytes(src)!;
    expect(plan.cues).toBe(2);
    const out = join(src, plan.parts);
    // the Segment has a known size, ending exactly at the end of the file
    const segAt = header.length;
    expect(out[segAt + 4]).toBe(0x01);
    const size = Number(
      new DataView(out.buffer, segAt + 4, 8).getBigUint64(0) & 0x00ffffffffffffffn,
    );
    expect(segAt + 12 + size).toBe(out.length);
    // every CueClusterPosition points at a Cluster ID
    const dataStart = segAt + 12;
    const positions: number[] = [];
    for (let i = 0; i < out.length - 2; i++) {
      if (out[i] === 0xf1 && out[i + 1]! >= 0x81 && out[i + 1]! <= 0x84) {
        const len = out[i + 1]! & 0x7f;
        positions.push(out.subarray(i + 2, i + 2 + len).reduce((v, x) => v * 256 + x, 0));
      }
    }
    const clusterAt = positions.map((p) => [...out.subarray(dataStart + p, dataStart + p + 4)]);
    expect(clusterAt).toEqual([
      [0x1f, 0x43, 0xb6, 0x75],
      [0x1f, 0x43, 0xb6, 0x75],
    ]);
  });

  it('keeps the frames byte for byte and is stable when run again', () => {
    const src = recording();
    const out = join(src, finalizeWebmBytes(src)!.parts);
    const again = finalizeWebmBytes(out)!;
    expect(again.durationSec).toBeCloseTo(1.099, 6);
    expect(join(out, again.parts)).toEqual(out);
  });

  it('drops a frame cut off at the end of the file', () => {
    const src = recording();
    const plan = finalizeWebmBytes(src.subarray(0, src.length - 3))!;
    // the 1066 ms frame is gone: 1033 + 33
    expect(plan.durationSec).toBeCloseTo(1.066, 6);
  });

  it('gives up on anything that is not WebM', () => {
    expect(finalizeWebmBytes(new TextEncoder().encode('webm-bytes'))).toBeUndefined();
    expect(finalizeWebmBytes(new Uint8Array(0))).toBeUndefined();
    expect(
      finalizeWebmBytes(new Uint8Array([...header, ...id(0x18538067), ...UNKNOWN, ...info])),
    ).toBeUndefined();
  });
});

describe('finalizeWebm (Blob)', () => {
  it('returns a finalized blob with the same type', async () => {
    const out = await finalizeWebm(new Blob([recording()], { type: 'video/webm' }));
    expect(out.type).toBe('video/webm');
    expect(webmDurationSec(new Uint8Array(await out.arrayBuffer()))).toBeCloseTo(1.099, 6);
  });

  it('hands back the input when it cannot finalize it', async () => {
    const blob = new Blob(['webm-bytes'], { type: 'video/webm' });
    expect(await finalizeWebm(blob)).toBe(blob);
  });
});
