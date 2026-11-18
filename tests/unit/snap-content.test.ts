// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDomDetector } from '../../src/content/dom-detect';
import { handleWorkerMessage } from '../../src/content/handler';
import { createSnapper, type SnapUi } from '../../src/content/snap';
import type { CaptureResult } from '../../src/content/snap-capture';
import type { ContentToWorker } from '../../src/core/messages';
import { DEFAULT_SNAP_OPTIONS, type SnapOptions } from '../../src/core/snap';

const PAGE = 'https://page.test/';
const good = (over: Partial<Extract<CaptureResult, { ok: true }>> = {}): CaptureResult => ({
  ok: true,
  blob: new Blob(['x'], { type: 'image/png' }),
  dataUrl: 'data:image/png;base64,eA==',
  width: 1920,
  height: 1080,
  time: 12.5,
  ...over,
});

function video(
  o: {
    playing?: boolean;
    w?: number;
    h?: number;
    src?: string;
    duration?: number;
    time?: number;
  } = {},
) {
  const v = document.createElement('video');
  const w = o.w ?? 640;
  const h = o.h ?? 360;
  v.getBoundingClientRect = () =>
    ({
      x: 10,
      y: 20,
      left: 10,
      top: 20,
      right: 10 + w,
      bottom: 20 + h,
      width: w,
      height: h,
    }) as DOMRect;
  Object.defineProperty(v, 'currentSrc', {
    value: o.src ?? 'https://cdn.test/a.mp4',
    configurable: true,
  });
  Object.defineProperty(v, 'paused', { value: !(o.playing ?? true), configurable: true });
  Object.defineProperty(v, 'duration', { value: o.duration ?? 100, configurable: true });
  Object.defineProperty(v, 'readyState', { value: 4, configurable: true });
  Object.defineProperty(v, 'videoWidth', { value: 1920, configurable: true });
  Object.defineProperty(v, 'videoHeight', { value: 1080, configurable: true });
  let t = o.time ?? 12.5;
  Object.defineProperty(v, 'currentTime', {
    get: () => t,
    set: (n: number) => void (t = n),
    configurable: true,
  });
  v.pause = vi.fn();
  document.body.append(v);
  return v;
}

function setup(
  over: {
    capture?: () => Promise<CaptureResult>;
    captureCors?: () => Promise<CaptureResult>;
    copy?: () => Promise<boolean>;
  } = {},
) {
  const sent: ContentToWorker[] = [];
  const ui = { flash: vi.fn(), toast: vi.fn() } satisfies SnapUi;
  const detector = createDomDetector({ document, frameUrl: PAGE, emit: () => {} });
  const capture = vi.fn<(v: HTMLVideoElement, o: SnapOptions) => Promise<CaptureResult>>(
    over.capture ?? (async () => good()),
  );
  const captureCors = vi.fn(
    over.captureCors ?? (async () => ({ ok: false, reason: 'tainted' }) as CaptureResult),
  );
  const copy = vi.fn(over.copy ?? (async () => true));
  const snapper = createSnapper({
    document,
    detector,
    send: (m) => sent.push(m),
    ui,
    capture,
    captureCors,
    copy,
  });
  return { sent, ui, snapper, capture, captureCors, copy, detector };
}

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = () => null;
  document.body.innerHTML = '';
  document.title = 'My page';
});
afterEach(() => vi.useRealTimers());

describe('snap capture', () => {
  it('sends the frame, flashes, and does not pause', async () => {
    const v = video();
    const { sent, ui, snapper } = setup();
    await snapper.capture({ options: DEFAULT_SNAP_OPTIONS });
    expect(sent).toEqual([
      expect.objectContaining({
        t: 'snap/data',
        dataUrl: 'data:image/png;base64,eA==',
        width: 1920,
        height: 1080,
        time: 12.5,
        format: 'png',
      }),
    ]);
    expect(ui.flash).toHaveBeenCalledOnce();
    expect(v.pause).not.toHaveBeenCalled();
  });

  it('prefers the playing video, then the largest', async () => {
    video({ playing: false, w: 1000, h: 500, src: 'https://cdn.test/big.mp4' });
    video({ playing: true, w: 300, h: 200, src: 'https://cdn.test/playing.mp4' });
    const { capture, snapper } = setup();
    await snapper.capture({ options: DEFAULT_SNAP_OPTIONS });
    expect((capture.mock.calls[0]![0] as HTMLVideoElement).currentSrc).toBe(
      'https://cdn.test/playing.mp4',
    );
  });

  it('captures the video named by elementKey', async () => {
    video({ playing: true, src: 'https://cdn.test/a.mp4' });
    video({ playing: false, src: 'https://cdn.test/b.mp4' });
    const { capture, snapper, detector } = setup();
    const b = detector.scan().find((s) => s.variants[0]?.url.endsWith('b.mp4'))!;
    await snapper.capture({ elementKey: b.frameRef!.elementKey, options: DEFAULT_SNAP_OPTIONS });
    expect((capture.mock.calls[0]![0] as HTMLVideoElement).currentSrc).toBe(
      'https://cdn.test/b.mp4',
    );
  });

  it('does nothing in a frame with no video', async () => {
    const { sent, ui, snapper } = setup();
    await snapper.capture({ options: DEFAULT_SNAP_OPTIONS });
    expect(sent).toEqual([]);
    expect(ui.flash).not.toHaveBeenCalled();
  });

  it('falls back to a CORS reload when the frame is tainted', async () => {
    video();
    const { sent, captureCors, snapper } = setup({
      capture: async () => ({ ok: false, reason: 'tainted' }),
      captureCors: async () => good({ width: 1280, height: 720 }),
    });
    await snapper.capture({ options: DEFAULT_SNAP_OPTIONS });
    expect(captureCors).toHaveBeenCalledOnce();
    expect(sent).toEqual([expect.objectContaining({ t: 'snap/data', width: 1280 })]);
  });

  it('asks the worker for a cropped tab capture when both reads fail', async () => {
    video({ w: 640, h: 360 });
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true });
    const { sent, snapper } = setup({ capture: async () => ({ ok: false, reason: 'tainted' }) });
    await snapper.capture({ options: { ...DEFAULT_SNAP_OPTIONS, format: 'jpeg', quality: 0.8 } });
    expect(sent).toEqual([
      expect.objectContaining({
        t: 'snap/tainted',
        rect: { x: 10, y: 20, width: 640, height: 360 },
        dpr: 2,
        format: 'jpeg',
        quality: 0.8,
      }),
    ]);
    Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
  });

  it('tells the user when there is no frame to read yet', async () => {
    video();
    const { sent, ui, snapper } = setup({
      capture: async () => ({ ok: false, reason: 'unavailable' }),
    });
    await snapper.capture({ options: DEFAULT_SNAP_OPTIONS });
    expect(sent).toEqual([]);
    expect(ui.toast).toHaveBeenCalledWith(expect.stringMatching(/no frame/i));
  });

  it('copies to the clipboard when asked, and offers click-to-copy when the browser refuses', async () => {
    video();
    const ok = setup();
    await ok.snapper.capture({ options: { ...DEFAULT_SNAP_OPTIONS, copy: true } });
    expect(ok.copy).toHaveBeenCalledOnce();
    expect(ok.ui.toast).not.toHaveBeenCalled();

    const denied = setup({ copy: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true) });
    await denied.snapper.capture({ options: { ...DEFAULT_SNAP_OPTIONS, copy: true } });
    const [text, action] = denied.ui.toast.mock.calls[0]!;
    expect(text).toMatch(/copy/i);
    await action.onClick();
    expect(denied.copy).toHaveBeenCalledTimes(2);
  });
});

describe('frame step', () => {
  it('pauses and moves one frame in the chosen direction', () => {
    const v = video({ playing: true, time: 5 });
    const { snapper } = setup();
    snapper.step(1);
    expect(v.pause).toHaveBeenCalled();
    expect(v.currentTime).toBeCloseTo(5 + 1 / 30, 5);
    snapper.step(-1);
    expect(v.currentTime).toBeCloseTo(5, 5);
  });
});

describe('burst', () => {
  it('snaps every N seconds up to the end of the clip and can be stopped', async () => {
    vi.useFakeTimers();
    video({ duration: 7, time: 0 });
    const { sent, snapper } = setup();
    snapper.burst({ intervalSec: 2, options: DEFAULT_SNAP_OPTIONS });
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sent).toHaveLength(3); // floor(7 / 2)
    expect(snapper.bursting).toBe(false);

    snapper.burst({ intervalSec: 1, options: DEFAULT_SNAP_OPTIONS });
    await vi.advanceTimersByTimeAsync(2000);
    const n = sent.length;
    snapper.stopBurst();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sent).toHaveLength(n);
  });

  it('never takes more than 200 frames', async () => {
    vi.useFakeTimers();
    video({ duration: 100_000, time: 0 });
    const { sent, snapper } = setup();
    snapper.burst({ intervalSec: 1, options: DEFAULT_SNAP_OPTIONS });
    await vi.advanceTimersByTimeAsync(400_000);
    expect(sent).toHaveLength(200);
  });
});

describe('content handler routing', () => {
  it('runs snap messages through the snapper', async () => {
    video();
    const { sent, snapper, detector } = setup();
    handleWorkerMessage(
      { t: 'snap/capture', options: DEFAULT_SNAP_OPTIONS },
      detector,
      PAGE,
      undefined,
      snapper,
    );
    await vi.waitFor(() => expect(sent).toHaveLength(1));
  });

  it('shows worker results as a toast', () => {
    const { ui, snapper, detector } = setup();
    handleWorkerMessage(
      { t: 'snap/result', kind: 'saved', text: 'Saved a.png' },
      detector,
      PAGE,
      undefined,
      snapper,
    );
    expect(ui.toast).toHaveBeenCalledWith('Saved a.png');
  });
});
