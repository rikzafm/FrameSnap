/** Browser wiring for the engine host (OPFS, ffmpeg.wasm, fetch, blob URLs). */
import type { EngineToWorker } from '../core/engine-messages';
import { MemoryChunkStore } from '../core/jobs/store';
import { Engine } from './engine';
import { FfmpegWasmBackend } from './ffmpeg-backend';
import { createEngineHost, type EngineHost } from './host';
import { OpfsChunkStore } from './opfs-chunk-store';

export interface BrowserEngineHost {
  host: EngineHost;
  dispose(): void;
}

export function createBrowserEngineHost(send: (m: EngineToWorker) => void): BrowserEngineHost {
  let opfs: OpfsChunkStore | undefined;
  const engine = new Engine(new FfmpegWasmBackend());
  const host = createEngineHost({
    send,
    opfs: () => {
      if (!navigator.storage?.getDirectory) throw new Error('OPFS unavailable');
      return (opfs ??= new OpfsChunkStore());
    },
    memory: new MemoryChunkStore(),
    engine,
    http: (url, init) => fetch(url, init),
    blobUrls: { create: (b) => URL.createObjectURL(b), revoke: (u) => URL.revokeObjectURL(u) },
    storage: {
      persist: () => navigator.storage.persist(),
      estimate: () => navigator.storage.estimate(),
    },
  });
  return {
    host,
    dispose: () => engine.dispose(),
  };
}
