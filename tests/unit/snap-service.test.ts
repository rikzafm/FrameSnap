import { describe, expect, it, vi } from 'vitest';
import { createSnapService, type SnapServiceDeps } from '../../src/background/snap';
import { routeContentMessage } from '../../src/background/router';
import { ERROR_COPY } from '../../src/core/errors';
import type { VideoSource } from '../../src/core/model';
import { isContentToWorker, isPopupToWorker, isWorkerToContent } from '../../src/core/messages';
import { DEFAULT_SNAP_OPTIONS } from '../../src/core/snap';

const source = (over: Partial<VideoSource> = {}): VideoSource => ({
  id: 'dom:1',
  site: 'reddit',
  title: 'Cat video',
  pageUrl: 'https://example.com/p',
  variants: [],
  audioTracks: [],
  protection: 'none',
  detectedBy: ['dom'],
  frameRef: { frameId: 3, elementKey: 'e7' },
  ...over,
});

function make(over: Partial<SnapServiceDeps> = {}) {
  const sent: { tabId: number; msg: unknown; frameId?: number }[] = [];
  const downloads: { url: string; filename: string }[] = [];
  const deps: SnapServiceDeps = {
    sendToTab: async (tabId, msg, frameId) =>
      void sent.push({ tabId, msg, ...(frameId === undefined ? {} : { frameId }) }),
    findSource: async (_t, id) => (id === 'dom:1' ? source() : undefined),
    getPrefs: async () => ({
      options: DEFAULT_SNAP_OPTIONS,
      template: '{title}-{site}-{resolution}',
    }),
    download: async (url, filename) => (downloads.push({ url, filename }), 1),
    captureVisibleTab: async () => 'data:image/png;base64,FULL',
    cropImage: async (_url, css, dpr, format) => ({
      dataUrl: `data:image/${format};base64,CROP${css.width * dpr}x${css.height * dpr}`,
      width: css.width * dpr,
      height: css.height * dpr,
    }),
    now: () => new Date(2026, 0, 5),
    ...over,
  };
  return { svc: createSnapService(deps), sent, downloads };
}

describe('snap requests', () => {
  it('sends the capture to the frame that owns the chosen source', async () => {
    const { svc, sent } = make();
    await svc.frame(9, { sourceId: 'dom:1' });
    expect(sent).toEqual([
      {
        tabId: 9,
        frameId: 3,
        msg: { t: 'snap/capture', elementKey: 'e7', options: DEFAULT_SNAP_OPTIONS },
      },
    ]);
  });

  it('broadcasts to every frame when no source is named (shortcut)', async () => {
    const { svc, sent } = make();
    await svc.frame(9, {});
    expect(sent).toEqual([{ tabId: 9, msg: { t: 'snap/capture', options: DEFAULT_SNAP_OPTIONS } }]);
  });

  it('targets only the best video of the tab when none is named, so one shortcut saves one file', async () => {
    const { svc, sent } = make({ bestSource: async () => source() });
    await svc.frame(9, {});
    expect(sent).toEqual([
      { tabId: 9, frameId: 3, msg: { t: 'snap/capture', elementKey: 'e7', options: DEFAULT_SNAP_OPTIONS } },
    ]);
  });

  it('broadcasts only when the tab has no known video element', async () => {
    const { svc, sent } = make({ bestSource: async () => undefined });
    await svc.frame(9, {});
    expect(sent).toEqual([{ tabId: 9, msg: { t: 'snap/capture', options: DEFAULT_SNAP_OPTIONS } }]);
  });

  it('uses options from the popup when given', async () => {
    const { svc, sent } = make();
    const options = { ...DEFAULT_SNAP_OPTIONS, format: 'webp' as const };
    await svc.frame(9, { options });
    expect(sent[0]!.msg).toMatchObject({ options });
  });

  it('forwards step, burst and stop', async () => {
    const { svc, sent } = make();
    await svc.step(9, 1, 'dom:1');
    await svc.burst(9, { intervalSec: 5, sourceId: 'dom:1' });
    await svc.stopBurst(9);
    expect(sent.map((s) => s.msg)).toEqual([
      { t: 'snap/step', dir: 1, elementKey: 'e7' },
      { t: 'snap/burst', intervalSec: 5, elementKey: 'e7', options: DEFAULT_SNAP_OPTIONS },
      { t: 'snap/burst-stop' },
    ]);
  });
});

describe('saving frames', () => {
  it('downloads the data URL named from the template with the playback time', async () => {
    const { svc, downloads, sent } = make();
    await svc.onData(9, {
      t: 'snap/data',
      dataUrl: 'data:image/png;base64,AAA',
      width: 1920,
      height: 1080,
      time: 75.5,
      title: 'Cat video',
      site: 'reddit',
      format: 'png',
    });
    expect(downloads).toEqual([
      { url: 'data:image/png;base64,AAA', filename: 'Cat video-reddit-1080p-01-15.500.png' },
    ]);
    expect(sent.at(-1)!.msg).toEqual({
      t: 'snap/result',
      kind: 'saved',
      text: 'Saved Cat video-reddit-1080p-01-15.500.png',
    });
  });

  it('keeps a {time} token the user already put in the template', async () => {
    const { svc, downloads } = make({
      getPrefs: async () => ({ options: DEFAULT_SNAP_OPTIONS, template: '{title}_{time}' }),
    });
    await svc.onData(9, {
      t: 'snap/data',
      dataUrl: 'data:image/jpeg;base64,AAA',
      width: 10,
      height: 10,
      time: 3,
      title: 'T',
      format: 'jpeg',
    });
    expect(downloads[0]!.filename).toBe('T_00-03.jpg');
  });

  it('reports a failed download', async () => {
    const { svc, sent } = make({ download: async () => Promise.reject(new Error('blocked')) });
    await svc.onData(9, {
      t: 'snap/data',
      dataUrl: 'data:image/png;base64,AAA',
      width: 1,
      height: 1,
      time: 0,
      title: 'T',
    });
    expect(sent.at(-1)!.msg).toMatchObject({ t: 'snap/result', kind: 'error' });
  });
});

describe('tainted frames (fallback B)', () => {
  it('captures the visible tab, crops to the video, saves, and tells the user it is screen resolution', async () => {
    const captureVisibleTab = vi.fn(async () => 'data:image/png;base64,FULL');
    const { svc, downloads, sent } = make({ captureVisibleTab });
    await svc.onTainted(9, {
      t: 'snap/tainted',
      rect: { x: 10, y: 20, width: 640, height: 360 },
      dpr: 2,
      time: 4,
      title: 'Cat video',
      site: 'reddit',
      format: 'png',
      quality: 0.9,
    });
    expect(captureVisibleTab).toHaveBeenCalledOnce();
    expect(downloads[0]).toEqual({
      url: 'data:image/png;base64,CROP1280x720',
      filename: 'Cat video-reddit-720p-00-04.png',
    });
    expect(sent.at(-1)!.msg).toEqual({
      t: 'snap/result',
      kind: 'tainted',
      text: ERROR_COPY.tainted.message,
    });
  });

  it('reports failure when the tab cannot be captured', async () => {
    const { svc, sent, downloads } = make({
      captureVisibleTab: async () => Promise.reject(new Error('no permission')),
    });
    await svc.onTainted(9, {
      t: 'snap/tainted',
      rect: { x: 0, y: 0, width: 10, height: 10 },
      dpr: 1,
      time: 0,
      title: 'T',
      format: 'png',
      quality: 1,
    });
    expect(downloads).toEqual([]);
    expect(sent.at(-1)!.msg).toMatchObject({ t: 'snap/result', kind: 'error' });
  });
});

describe('content message routing', () => {
  it('routes snap/data and snap/tainted from a tab to the handlers', async () => {
    const onSnapData = vi.fn();
    const onSnapTainted = vi.fn();
    const msg = { t: 'snap/data' as const, dataUrl: 'd', width: 1, height: 1, time: 0, title: 'T' };
    await routeContentMessage(msg, { tabId: 4, frameId: 0 }, { onSnapData, onSnapTainted });
    expect(onSnapData).toHaveBeenCalledWith(4, msg);
    const t = {
      t: 'snap/tainted' as const,
      rect: { x: 0, y: 0, width: 1, height: 1 },
      dpr: 1,
      time: 0,
      title: 'T',
      format: 'png' as const,
      quality: 1,
    };
    await routeContentMessage(t, { tabId: 4, frameId: 0 }, { onSnapData, onSnapTainted });
    expect(onSnapTainted).toHaveBeenCalledWith(4, t);
  });

  it('routes the picker Snap action to a frame request', async () => {
    const onAction = vi.fn();
    const src = source({ frameRef: { frameId: 0, elementKey: 'e7' } });
    await routeContentMessage(
      { t: 'picker/action', action: 'snap', source: src },
      { tabId: 4, frameId: 2 },
      { onAction },
    );
    expect(onAction).toHaveBeenCalledWith(
      'snap',
      4,
      expect.objectContaining({ frameRef: { frameId: 2, elementKey: 'e7' } }),
    );
  });
});

describe('message guards', () => {
  it('accept well-formed snap messages and reject malformed ones', () => {
    expect(isPopupToWorker({ t: 'snap/step', tabId: 1, dir: 1 })).toBe(true);
    expect(isPopupToWorker({ t: 'snap/step', tabId: 1, dir: 2 })).toBe(false);
    expect(
      isPopupToWorker({ t: 'snap/burst', tabId: 1, intervalSec: 5, options: DEFAULT_SNAP_OPTIONS }),
    ).toBe(true);
    expect(isPopupToWorker({ t: 'snap/frame', tabId: 1, options: { format: 'bmp' } })).toBe(false);
    expect(isWorkerToContent({ t: 'snap/capture', options: DEFAULT_SNAP_OPTIONS })).toBe(true);
    expect(isWorkerToContent({ t: 'snap/capture' })).toBe(false);
    expect(
      isContentToWorker({
        t: 'snap/tainted',
        rect: { x: 0, y: 0, width: 1, height: 1 },
        dpr: 1,
        time: 0,
        title: 'T',
        format: 'png',
        quality: 1,
      }),
    ).toBe(true);
    expect(
      isContentToWorker({
        t: 'snap/tainted',
        rect: {},
        dpr: 1,
        time: 0,
        title: 'T',
        format: 'png',
        quality: 1,
      }),
    ).toBe(false);
  });
});
