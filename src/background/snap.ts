/**
 * Frame snap in the service worker: route requests to the right frame, name and
 * download captured frames, and run fallback B (cropped `captureVisibleTab`).
 * Everything chrome-specific is injected.
 */
import { ERROR_COPY } from '../core/errors';
import { buildFilename } from '../core/filename';
import type { ContentToWorker, WorkerToContent } from '../core/messages';
import type { VideoSource } from '../core/model';
import { extensionOf, type Rect, type SnapFormat, type SnapOptions } from '../core/snap';

type SnapData = Extract<ContentToWorker, { t: 'snap/data' }>;
type SnapTainted = Extract<ContentToWorker, { t: 'snap/tainted' }>;

export interface SnapServiceDeps {
  sendToTab(tabId: number, message: WorkerToContent, frameId?: number): Promise<unknown>;
  findSource(tabId: number, sourceId: string): Promise<VideoSource | undefined>;
  getPrefs(): Promise<{ options: SnapOptions; template: string }>;
  download(url: string, filename: string): Promise<number>;
  captureVisibleTab(tabId: number): Promise<string>;
  /** Crop the video rect (CSS pixels, scaled by `dpr`, clipped to the capture) out of a captured image and re-encode it. */
  cropImage(
    dataUrl: string,
    css: Rect,
    dpr: number,
    format: SnapFormat,
    quality: number,
  ): Promise<{ dataUrl: string; width: number; height: number }>;
  now(): Date;
}

export interface SnapRequest {
  sourceId?: string;
  /** A source the page already named (picker action); wins over `sourceId`. */
  source?: VideoSource;
  options?: SnapOptions;
}

export interface SnapService {
  frame(tabId: number, req: SnapRequest): Promise<void>;
  step(tabId: number, dir: 1 | -1, sourceId?: string): Promise<void>;
  burst(
    tabId: number,
    req: { sourceId?: string; intervalSec: number; options?: SnapOptions },
  ): Promise<void>;
  stopBurst(tabId: number): Promise<void>;
  onData(tabId: number, msg: SnapData): Promise<void>;
  onTainted(tabId: number, msg: SnapTainted): Promise<void>;
}

export function createSnapService(deps: SnapServiceDeps): SnapService {
  /** Frame and element to talk to; both absent when the source has no DOM element (broadcast instead). */
  async function targetOf(tabId: number, req: { sourceId?: string; source?: VideoSource }) {
    const source =
      req.source ?? (req.sourceId ? await deps.findSource(tabId, req.sourceId) : undefined);
    const key = source?.frameRef?.elementKey;
    return key ? { elementKey: key, frameId: source!.frameRef!.frameId } : {};
  }

  const send = (tabId: number, msg: WorkerToContent, frameId?: number) =>
    deps.sendToTab(tabId, msg, frameId).then(
      () => undefined,
      () => undefined,
    );

  async function save(
    tabId: number,
    img: { dataUrl: string; width: number; height: number },
    m: { title: string; site?: string; time: number; format: SnapFormat },
    kind: 'saved' | 'tainted',
  ) {
    const { template } = await deps.getPrefs();
    // Many snaps of one video must not collide, so the template always carries the time.
    const tpl = template.includes('{time}') ? template : `${template}-{time}`;
    const filename = buildFilename(
      tpl,
      {
        title: m.title,
        site: m.site ?? '',
        date: deps.now(),
        width: img.width,
        height: img.height,
        time: m.time,
      },
      extensionOf(m.format),
    );
    try {
      await deps.download(img.dataUrl, filename);
    } catch {
      await send(tabId, {
        t: 'snap/result',
        kind: 'error',
        text: 'Could not save the frame. Check your download settings.',
      });
      return;
    }
    await send(tabId, {
      t: 'snap/result',
      kind,
      text: kind === 'tainted' ? ERROR_COPY.tainted.message : `Saved ${filename}`,
    });
  }

  return {
    async frame(tabId, req) {
      const options = req.options ?? (await deps.getPrefs()).options;
      const t = await targetOf(tabId, req);
      await send(
        tabId,
        { t: 'snap/capture', ...(t.elementKey ? { elementKey: t.elementKey } : {}), options },
        t.frameId,
      );
    },
    async step(tabId, dir, sourceId) {
      const t = await targetOf(tabId, { ...(sourceId ? { sourceId } : {}) });
      await send(
        tabId,
        { t: 'snap/step', dir, ...(t.elementKey ? { elementKey: t.elementKey } : {}) },
        t.frameId,
      );
    },
    async burst(tabId, req) {
      const options = req.options ?? (await deps.getPrefs()).options;
      const t = await targetOf(tabId, req);
      await send(
        tabId,
        {
          t: 'snap/burst',
          intervalSec: req.intervalSec,
          ...(t.elementKey ? { elementKey: t.elementKey } : {}),
          options,
        },
        t.frameId,
      );
    },
    async stopBurst(tabId) {
      await send(tabId, { t: 'snap/burst-stop' });
    },
    async onData(tabId, msg) {
      await save(
        tabId,
        msg,
        {
          title: msg.title,
          ...(msg.site ? { site: msg.site } : {}),
          time: msg.time,
          format: msg.format ?? 'png',
        },
        'saved',
      );
    },
    async onTainted(tabId, msg) {
      try {
        const full = await deps.captureVisibleTab(tabId);
        const img = await deps.cropImage(full, msg.rect, msg.dpr, msg.format, msg.quality);
        await save(
          tabId,
          img,
          {
            title: msg.title,
            ...(msg.site ? { site: msg.site } : {}),
            time: msg.time,
            format: msg.format,
          },
          'tainted',
        );
      } catch {
        await send(tabId, {
          t: 'snap/result',
          kind: 'error',
          text: 'Could not capture this frame.',
        });
      }
    },
  };
}
