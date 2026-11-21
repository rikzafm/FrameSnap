/**
 * In-process engine lifecycle and message link for browsers without
 * `chrome.offscreen` (Firefox MV3 event pages, which already have DOM/Workers/OPFS).
 */
import type { EngineToWorker, WorkerToEngine } from '../core/engine-messages';
import type { EngineHost } from '../offscreen/host';
import { IDLE_CLOSE_MS, type EngineLifecycle } from './engine-lifecycle';

export interface LocalEngineOptions {
  createHost: (
    send: (m: EngineToWorker) => void,
  ) => Promise<{ host: EngineHost; dispose(): void }>;
  onMessage: (m: EngineToWorker) => void;
  idleMs?: number;
}

export interface LocalEngine {
  lifecycle: EngineLifecycle;
  engine: { send(msg: WorkerToEngine): Promise<void> };
}

export function createLocalEngine(opts: LocalEngineOptions): LocalEngine {
  const { createHost, onMessage, idleMs = IDLE_CLOSE_MS } = opts;
  const active = new Set<string>();
  let instance: { host: EngineHost; dispose(): void } | undefined;
  let creating: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancelIdle = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const armIdle = () => {
    cancelIdle();
    if (active.size > 0 || !instance) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (active.size === 0 && instance) {
        instance.dispose();
        instance = undefined;
      }
    }, idleMs);
  };

  const ensure = (): Promise<void> => {
    cancelIdle();
    if (instance) return Promise.resolve();
    creating ??= (async () => {
      try {
        const created = await createHost((m) => queueMicrotask(() => onMessage(m)));
        instance = created;
        await created.host.connect();
      } catch (err) {
        instance = undefined;
        throw err;
      } finally {
        creating = undefined;
      }
    })();
    return creating;
  };

  return {
    lifecycle: {
      ensure,
      exists: () => Promise.resolve(instance !== undefined),
      jobStarted(jobId) {
        active.add(jobId);
        cancelIdle();
      },
      jobFinished(jobId) {
        active.delete(jobId);
        armIdle();
      },
    },
    engine: {
      async send(msg) {
        await ensure();
        void instance!.host.handle(msg);
        if (active.size === 0) armIdle();
      },
    },
  };
}
