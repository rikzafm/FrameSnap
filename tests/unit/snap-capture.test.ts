import { describe, expect, it, vi } from 'vitest';
import {
  captureFrame,
  captureViaCrossOrigin,
  type CaptureDeps,
} from '../../src/content/snap-capture';
import { DEFAULT_SNAP_OPTIONS } from '../../src/core/snap';

function video(over: Partial<Record<string, unknown>> = {}) {
  return {
    readyState: 4,
    paused: false,
    currentTime: 12.5,
    videoWidth: 1920,
    videoHeight: 1080,
    pause: vi.fn(),
    ...over,
  } as unknown as HTMLVideoElement;
}

function deps(over: Partial<CaptureDeps> = {}) {
  const calls: string[] = [];
  const d: CaptureDeps = {
    nextFrame: async () => void calls.push('frame'),
    bitmap: async (v) => {
      calls.push('bitmap');
      return { width: v.videoWidth, height: v.videoHeight, close: () => void calls.push('close') };
    },
    encode: async (bmp, mime, quality) => {
      calls.push(`encode ${bmp.width}x${bmp.height} ${mime} ${quality}`);
      return new Blob(['x'], { type: mime });
    },
    toDataUrl: async (b) => `data:${b.type};base64,eA==`,
    ...over,
  };
  return { d, calls };
}

describe('captureFrame', () => {
  it("captures at the video's native size, not the element size, without pausing", async () => {
    const v = video();
    const { d, calls } = deps();
    const r = await captureFrame(v, DEFAULT_SNAP_OPTIONS, d);
    expect(r).toMatchObject({
      ok: true,
      width: 1920,
      height: 1080,
      time: 12.5,
      dataUrl: 'data:image/png;base64,eA==',
    });
    expect(calls).toContain('encode 1920x1080 image/png 0.92');
    expect(calls).toContain('close');
    expect(v.pause).not.toHaveBeenCalled();
  });

  it('waits for a presented frame while playing, not while paused', async () => {
    const playing = deps();
    await captureFrame(video(), DEFAULT_SNAP_OPTIONS, playing.d);
    expect(playing.calls.indexOf('frame')).toBeGreaterThanOrEqual(0);
    expect(playing.calls.indexOf('frame')).toBeLessThan(playing.calls.indexOf('bitmap'));
    const paused = deps();
    await captureFrame(video({ paused: true }), DEFAULT_SNAP_OPTIONS, paused.d);
    expect(paused.calls).not.toContain('frame');
  });

  it('honours the chosen format and quality', async () => {
    const { d, calls } = deps();
    const r = await captureFrame(
      video(),
      { ...DEFAULT_SNAP_OPTIONS, format: 'jpeg', quality: 0.6 },
      d,
    );
    expect(calls).toContain('encode 1920x1080 image/jpeg 0.6');
    expect(r).toMatchObject({ ok: true, dataUrl: 'data:image/jpeg;base64,eA==' });
  });

  it('reports a cross-origin frame as tainted', async () => {
    const { d } = deps({
      bitmap: async () => {
        throw new DOMException('tainted', 'SecurityError');
      },
    });
    expect(await captureFrame(video(), DEFAULT_SNAP_OPTIONS, d)).toEqual({
      ok: false,
      reason: 'tainted',
    });
  });

  it('reports a video with no frame yet as unavailable', async () => {
    const { d } = deps();
    expect(
      await captureFrame(video({ readyState: 1, videoWidth: 0 }), DEFAULT_SNAP_OPTIONS, d),
    ).toEqual({ ok: false, reason: 'unavailable' });
  });
});

function fakeClone(over: Record<string, unknown> = {}) {
  return Object.assign(new EventTarget(), {
    crossOrigin: '',
    muted: false,
    preload: '',
    readyState: 4,
    paused: true,
    currentTime: 0,
    videoWidth: 1280,
    videoHeight: 720,
    src: '',
    removeAttribute() {},
    remove() {},
    ...over,
  });
}

describe('captureViaCrossOrigin (fallback A)', () => {
  it('reloads the source with crossorigin, seeks to the same time and captures that copy', async () => {
    const clone = fakeClone();
    const original = video({ currentSrc: 'https://cdn.test/v.mp4', currentTime: 7.25 });
    const { d, calls } = deps();
    const run = captureViaCrossOrigin(
      original,
      DEFAULT_SNAP_OPTIONS,
      d,
      () => clone as unknown as HTMLVideoElement,
    );
    await new Promise((r) => setTimeout(r, 0));
    clone.dispatchEvent(new Event('loadedmetadata'));
    await new Promise((r) => setTimeout(r, 0));
    clone.dispatchEvent(new Event('seeked'));
    const r = await run;
    expect(clone.crossOrigin).toBe('anonymous');
    expect(clone.src).toBe('https://cdn.test/v.mp4');
    expect(clone.currentTime).toBe(7.25);
    expect(calls).toContain('encode 1280x720 image/png 0.92');
    expect(r).toMatchObject({ ok: true, width: 1280, time: 7.25 });
  });

  it('gives up when the clone cannot load with CORS', async () => {
    const clone = fakeClone({ readyState: 0, videoWidth: 0, videoHeight: 0 });
    const run = captureViaCrossOrigin(
      video({ currentSrc: 'https://cdn.test/v.mp4' }),
      DEFAULT_SNAP_OPTIONS,
      deps().d,
      () => clone as unknown as HTMLVideoElement,
    );
    await new Promise((r) => setTimeout(r, 0));
    clone.dispatchEvent(new Event('error'));
    expect(await run).toEqual({ ok: false, reason: 'tainted' });
  });
});
