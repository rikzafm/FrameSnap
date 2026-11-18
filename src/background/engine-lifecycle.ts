/**
 * Offscreen document lifecycle, owned by the service worker: create it when a
 * job needs the engine, close it after IDLE_CLOSE_MS with no job. A job counts
 * as active until its result has been saved (the blob: URL lives in the
 * document, so closing it earlier would lose the file).
 */

export const IDLE_CLOSE_MS = 60_000;
export const ENGINE_REASONS = ['BLOBS', 'WORKERS'] as unknown as chrome.offscreen.Reason[];

export interface OffscreenApi {
  has(): Promise<boolean>;
  create(url: string, reasons: chrome.offscreen.Reason[], justification: string): Promise<void>;
  close(): Promise<void>;
}

export interface EngineLifecycleOptions {
  api: OffscreenApi;
  /** Extension-relative path of the offscreen page. */
  url: string;
  idleMs?: number;
}

export interface EngineLifecycle {
  /** Resolves once the offscreen document exists. Safe to call concurrently. */
  ensure(): Promise<void>;
  jobStarted(jobId: string): void;
  jobFinished(jobId: string): void;
}

export function createEngineLifecycle(opts: EngineLifecycleOptions): EngineLifecycle {
  const { api, url, idleMs = IDLE_CLOSE_MS } = opts;
  const active = new Set<string>();
  let creating: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancelIdle = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const armIdle = () => {
    cancelIdle();
    if (active.size > 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (active.size === 0) void api.close().catch(() => {});
    }, idleMs);
  };

  return {
    ensure() {
      cancelIdle();
      creating ??= (async () => {
        try {
          if (!(await api.has()))
            await api.create(
              url,
              ENGINE_REASONS,
              'Convert video with ffmpeg.wasm, keep resumable chunks and hand blobs to downloads',
            );
        } finally {
          creating = undefined;
        }
      })();
      return creating;
    },
    jobStarted(jobId) {
      active.add(jobId);
      cancelIdle();
    },
    jobFinished(jobId) {
      active.delete(jobId);
      armIdle();
    },
  };
}
