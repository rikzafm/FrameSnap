import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/**
 * An offscreen document only has chrome.runtime. Importing anything that touches chrome.tabs,
 * chrome.storage etc. at load time throws there and the engine never connects (found in real
 * Chrome: downloads sat at "Waiting 0 %"). The port also connects synchronously, so the host
 * must exist before that first onConnect.
 */
it('loads with only chrome.runtime and announces the engine as ready on the port', async () => {
  const posted: unknown[] = [];
  const connect = vi.fn(() => ({
    name: 'engine',
    postMessage: (m: unknown) => posted.push(m),
    disconnect: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onDisconnect: { addListener: vi.fn() },
  }));
  vi.stubGlobal('chrome', { runtime: { connect } });
  vi.stubGlobal('navigator', {
    storage: {
      persist: async () => false,
      estimate: async () => ({ usage: 1, quota: 2 }),
    },
  });
  await import('../../src/offscreen/main');
  expect(connect).toHaveBeenCalledWith({ name: 'engine' });
  await vi.waitFor(() =>
    expect(posted).toContainEqual(expect.objectContaining({ t: 'engine/ready' })),
  );
});
