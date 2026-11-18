import { describe, expect, it, vi } from 'vitest';
import {
  ENGINE_REASONS,
  IDLE_CLOSE_MS,
  createEngineLifecycle,
} from '../../src/background/engine-lifecycle';

function setup() {
  vi.useFakeTimers();
  let exists = false;
  const api = {
    has: vi.fn(async () => exists),
    create: vi.fn(async () => {
      await Promise.resolve();
      exists = true;
    }),
    close: vi.fn(async () => {
      exists = false;
    }),
  };
  const life = createEngineLifecycle({ api, url: 'src/offscreen/index.html' });
  return { api, life };
}

describe('engine lifecycle', () => {
  it('creates the offscreen document on demand with BLOBS and WORKERS, once even for concurrent callers', async () => {
    const { api, life } = setup();
    await Promise.all([life.ensure(), life.ensure()]);
    await life.ensure();
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.create).toHaveBeenCalledWith(
      'src/offscreen/index.html',
      ENGINE_REASONS,
      expect.any(String),
    );
    expect(ENGINE_REASONS).toEqual(['BLOBS', 'WORKERS']);
    vi.useRealTimers();
  });

  it('closes after 60 s with no job, not before', async () => {
    const { api, life } = setup();
    await life.ensure();
    life.jobStarted('a');
    life.jobFinished('a');
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS - 1);
    expect(api.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('a running job keeps it open, and a new job resets the idle timer', async () => {
    const { api, life } = setup();
    await life.ensure();
    life.jobStarted('a');
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS * 3);
    expect(api.close).not.toHaveBeenCalled();

    life.jobFinished('a');
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS - 1000);
    life.jobStarted('b');
    life.jobFinished('b');
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS - 1);
    expect(api.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('recreates the document after it was closed', async () => {
    const { api, life } = setup();
    await life.ensure();
    life.jobStarted('a');
    life.jobFinished('a');
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS);
    await life.ensure();
    expect(api.create).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
