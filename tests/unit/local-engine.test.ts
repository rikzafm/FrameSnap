import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDLE_CLOSE_MS } from '../../src/background/engine-lifecycle';
import { createLocalEngine } from '../../src/background/local-engine';
import type { EngineToWorker } from '../../src/core/engine-messages';
import type { EngineHost } from '../../src/offscreen/host';

function setup(idleMs?: number) {
  vi.useFakeTimers();
  const handled: unknown[] = [];
  const received: EngineToWorker[] = [];
  const dispose = vi.fn();
  const connect = vi.fn(async () => undefined);
  const createHost = vi.fn(async (send: (m: EngineToWorker) => void) => {
    await Promise.resolve();
    const host: EngineHost = {
      connect: async () => {
        await connect();
        send({ t: 'engine/ready', storage: { usage: 0, quota: 100, persisted: false } });
      },
      handle: async (msg) => {
        handled.push(msg);
        if (msg.t === 'engine/status') send({ t: 'engine/running', jobs: [] });
      },
    };
    return { host, dispose };
  });
  const local = createLocalEngine({
    createHost,
    onMessage: (m) => received.push(m),
    ...(idleMs !== undefined ? { idleMs } : {}),
  });
  return { local, createHost, connect, dispose, handled, received };
}

describe('local engine (Firefox in-process host)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates the host lazily once across concurrent callers and connects it', async () => {
    const { local, createHost, connect, received } = setup();
    expect(await local.lifecycle.exists()).toBe(false);
    await Promise.all([local.lifecycle.ensure(), local.lifecycle.ensure()]);
    await local.lifecycle.ensure();
    expect(createHost).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(await local.lifecycle.exists()).toBe(true);
    await Promise.resolve();
    expect(received).toContainEqual(expect.objectContaining({ t: 'engine/ready' }));
  });

  it('forwards commands without blocking on long handle() work and delivers replies via onMessage', async () => {
    vi.useRealTimers();
    let releaseFetch!: () => void;
    const gate = new Promise<void>((r) => (releaseFetch = r));
    const handled: unknown[] = [];
    const received: EngineToWorker[] = [];
    const local = createLocalEngine({
      createHost: async (send) => ({
        host: {
          connect: async () => send({ t: 'engine/ready', storage: { usage: 0, quota: 100, persisted: false } }),
          handle: async (msg) => {
            handled.push(msg);
            if (msg.t === 'engine/fetch') await gate;
            if (msg.t === 'engine/status') send({ t: 'engine/running', jobs: [{ jobId: '1', phase: 'fetch' }] });
          },
        },
        dispose: vi.fn(),
      }),
      onMessage: (m) => received.push(m),
    });

    // send resolves immediately even while engine/fetch is awaiting gate
    await local.engine.send({ t: 'engine/fetch', jobId: '1', tracks: [] });
    await local.engine.send({ t: 'engine/status' });
    expect(handled.map((m) => (m as { t: string }).t)).toEqual(['engine/fetch', 'engine/status']);
    await vi.waitFor(() =>
      expect(received).toContainEqual({
        t: 'engine/running',
        jobs: [{ jobId: '1', phase: 'fetch' }],
      }),
    );
    releaseFetch();
  });

  it('disposes after idle timeout when no job is active, and recreates afterwards', async () => {
    const { local, createHost, dispose } = setup();
    await local.lifecycle.ensure();
    local.lifecycle.jobStarted('a');
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS * 2);
    expect(dispose).not.toHaveBeenCalled();

    local.lifecycle.jobFinished('a');
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS - 1);
    expect(dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(await local.lifecycle.exists()).toBe(false);

    await local.lifecycle.ensure();
    expect(createHost).toHaveBeenCalledTimes(2);
    expect(await local.lifecycle.exists()).toBe(true);
  });

  it('cleans up an ad-hoc send when no job is active after the idle delay', async () => {
    const { local, dispose } = setup(5000);
    await local.engine.send({ t: 'engine/discard', jobId: 'old' });
    await vi.advanceTimersByTimeAsync(4999);
    expect(dispose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
