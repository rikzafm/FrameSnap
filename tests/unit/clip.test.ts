import { describe, expect, it } from 'vitest';
import { padMp4 } from '../e2e/clip';

const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint32(at);
const tag = (b: Uint8Array, at: number) => String.fromCharCode(...b.slice(at, at + 4));

describe('padMp4', () => {
  const clip = new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]); // an 8-byte "ftyp" box

  it('grows a clip to the target size with one trailing free box, keeping the original bytes', () => {
    const out = padMp4(clip, 100);
    expect(out.length).toBe(100);
    expect(out.slice(0, 8)).toEqual(clip);
    expect(u32(out, 8)).toBe(92);
    expect(tag(out, 12)).toBe('free');
  });

  it('leaves a clip that is already large enough alone', () => {
    expect(padMp4(clip, 4)).toEqual(clip);
  });
});
