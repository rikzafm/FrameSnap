/** Offscreen document entry: connects the engine host to the service worker over the "engine" port. */
import { isWorkerToEngine } from '../core/engine-messages';
import { MemoryChunkStore } from '../core/jobs/store';
import { ENGINE_PORT, connectWithReconnect } from '../platform/ports';
import { runtime } from '../platform/chrome';
import { Engine } from './engine';
import { FfmpegWasmBackend } from './ffmpeg-backend';
import { createEngineHost } from './host';
import { OpfsChunkStore } from './opfs-chunk-store';

let opfs: OpfsChunkStore | undefined;

const port = connectWithReconnect({
  name: ENGINE_PORT,
  connect: runtime.connect,
  guard: isWorkerToEngine,
  onMessage: (m) => void host.handle(m),
  onConnect: () => void host.connect(),
});

const host = createEngineHost({
  send: (m) => port.post(m),
  opfs: () => {
    if (!navigator.storage?.getDirectory) throw new Error('OPFS unavailable');
    return (opfs ??= new OpfsChunkStore());
  },
  memory: new MemoryChunkStore(),
  engine: new Engine(new FfmpegWasmBackend()),
  http: (url, init) => fetch(url, init),
  blobUrls: { create: (b) => URL.createObjectURL(b), revoke: (u) => URL.revokeObjectURL(u) },
  storage: {
    persist: () => navigator.storage.persist(),
    estimate: () => navigator.storage.estimate(),
  },
});
