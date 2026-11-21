/** Offscreen document entry: connects the engine host to the service worker over the "engine" port. */
import { isWorkerToEngine } from '../core/engine-messages';
import { ENGINE_PORT, connectWithReconnect, type PortLike } from '../platform/ports';
import { createBrowserEngineHost } from './browser-host';

/** The live port. Set inside onConnect, which connectWithReconnect runs before it returns. */
let current: PortLike | undefined;

const { host } = createBrowserEngineHost((m) => {
  try {
    current?.postMessage(m);
  } catch {
    // the worker went away; the reconnect announces state again
  }
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

// While the document is open it keeps the service worker awake: Chrome stops a worker after about
// 30 s without events, and a save or a long ffmpeg run sends none. `engine/status` is cheap and the
// worker ignores it unless it asked.
const HEARTBEAT_MS = 20_000;
setInterval(() => void host.handle({ t: 'engine/status' }), HEARTBEAT_MS);
