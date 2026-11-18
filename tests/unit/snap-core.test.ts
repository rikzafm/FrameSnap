import { describe, expect, it } from 'vitest';
import {
  BURST_CAP,
  DEFAULT_SNAP_OPTIONS,
  burstCount,
  cropRect,
  extensionOf,
  mimeOf,
  normalizeSnapOptions,
  stepTime,
} from '../../src/core/snap';

describe('snap options', () => {
  it('maps formats to mime types and file extensions', () => {
    expect(mimeOf('png')).toBe('image/png');
    expect(mimeOf('jpeg')).toBe('image/jpeg');
    expect(mimeOf('webp')).toBe('image/webp');
    expect(extensionOf('jpeg')).toBe('jpg');
    expect(extensionOf('png')).toBe('png');
  });

  it('repairs corrupt stored options', () => {
    expect(normalizeSnapOptions(undefined)).toEqual(DEFAULT_SNAP_OPTIONS);
    expect(normalizeSnapOptions({ format: 'bmp', quality: 7, copy: 'yes', showButton: 1 })).toEqual(
      { ...DEFAULT_SNAP_OPTIONS, quality: 1 },
    );
    expect(
      normalizeSnapOptions({ format: 'webp', quality: 0.5, copy: true, showButton: false }),
    ).toEqual({ format: 'webp', quality: 0.5, copy: true, showButton: false });
  });
});

describe('burst', () => {
  it('counts frames until the end, capped at 200', () => {
    expect(burstCount({ interval: 2, from: 0, duration: 10 })).toBe(5);
    expect(burstCount({ interval: 1, from: 0, duration: 10_000 })).toBe(BURST_CAP);
    expect(burstCount({ interval: 1, from: 0 })).toBe(BURST_CAP);
    expect(burstCount({ interval: 0, from: 0, duration: 10 })).toBe(10);
  });
});

describe('frame step', () => {
  it('moves one frame and stays inside the clip', () => {
    expect(stepTime(1, 1, 10)).toBeCloseTo(1 + 1 / 30, 5);
    expect(stepTime(1, -1, 10)).toBeCloseTo(1 - 1 / 30, 5);
    expect(stepTime(0, -1, 10)).toBe(0);
    expect(stepTime(10, 1, 10)).toBe(10);
  });
});

describe('visible tab crop', () => {
  it('scales the video rect by the device pixel ratio and clips to the capture', () => {
    expect(
      cropRect({ x: 10, y: 20, width: 100, height: 50 }, 2, { width: 1000, height: 800 }),
    ).toEqual({ x: 20, y: 40, width: 200, height: 100 });
    expect(
      cropRect({ x: -10, y: 0, width: 100, height: 50 }, 1, { width: 1000, height: 800 }),
    ).toEqual({ x: 0, y: 0, width: 90, height: 50 });
    expect(
      cropRect({ x: 950, y: 0, width: 100, height: 50 }, 1, { width: 1000, height: 800 }),
    ).toEqual({ x: 950, y: 0, width: 50, height: 50 });
  });
});
