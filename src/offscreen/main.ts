/** Offscreen document entry: connects the engine host to the service worker over the "engine" port. */
import { isWorkerToEngine } from '../core/engine-messages';
import { MemoryChunkStore } from '../core/jobs/store';
import { ENGINE_PORT, connectWithReconnect, type PortLike } from '../platform/ports';
import { Engine } from './engine';
import { FfmpegWasmBackend } from './ffmpeg-backend';
import { createEngineHost } from './host';
import { OpfsChunkStore } from './opfs-chunk-store';

let opfs: OpfsChunkStore | undefined;
/** The live port. Set inside onConnect, which connectWithReconnect runs before it returns. */
let current: PortLike | undefined;

const host = createEngineHost({
  send: (m) => {
    try {
      current?.postMessage(m);
    } catch {
      // the worker went away; the reconnect announces state again
    }
  },
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

connectWithReconnect({
  name: ENGINE_PORT,
  // Not ../platform/chrome: an offscreen document has only chrome.runtime, and that module reads
  // other APIs when it loads.
  connect: (name) => chrome.runtime.connect({ name }),
  guard: isWorkerToEngine,
  onMessage: (m) => void host.handle(m),
  onConnect: (p) => {
    current = p;
    void host.connect();
  },
});
