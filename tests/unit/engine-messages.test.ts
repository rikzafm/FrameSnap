import { describe, expect, it } from 'vitest';
import { isEngineToWorker, isWorkerToEngine } from '../../src/core/engine-messages';

describe('engine message guards', () => {
  it('accepts well-formed commands and rejects malformed ones', () => {
    expect(isWorkerToEngine({ t: 'engine/cancel', jobId: 'j' })).toBe(true);
    expect(isWorkerToEngine({ t: 'engine/cancel' })).toBe(false);
    expect(isWorkerToEngine({ t: 'engine/revoke', url: 'blob:x' })).toBe(true);
    expect(isWorkerToEngine({ t: 'engine/storage' })).toBe(true);
    expect(
      isWorkerToEngine({ t: 'engine/fetch', jobId: 'j', tracks: [{ trackId: '0', chunks: [] }] }),
    ).toBe(true);
    expect(isWorkerToEngine({ t: 'engine/fetch', jobId: 'j', tracks: 'nope' })).toBe(false);
    expect(
      isWorkerToEngine({
        t: 'engine/download',
        jobId: 'j',
        plan: {},
        tracks: [{ trackId: '0', keys: ['a'] }],
        seeks: [],
      }),
    ).toBe(true);
    expect(
      isWorkerToEngine({
        t: 'engine/download',
        jobId: 'j',
        plan: {},
        tracks: [{ trackId: '0', keys: [1] }],
        seeks: [],
      }),
    ).toBe(false);
    expect(isWorkerToEngine({ t: 'bogus' })).toBe(false);
    expect(isWorkerToEngine(null)).toBe(false);
  });

  it('accepts well-formed reports and rejects malformed ones', () => {
    expect(
      isEngineToWorker({ t: 'engine/ready', storage: { usage: 1, quota: 2, persisted: true } }),
    ).toBe(true);
    expect(isEngineToWorker({ t: 'engine/ready', storage: { usage: 1, quota: 2 } })).toBe(false);
    expect(
      isEngineToWorker({ t: 'engine/commit', jobId: 'j', trackId: '0', key: 'k', bytes: 5 }),
    ).toBe(true);
    expect(
      isEngineToWorker({ t: 'engine/progress', jobId: 'j', phase: 'engine', ratio: 0.5 }),
    ).toBe(true);
    expect(isEngineToWorker({ t: 'engine/progress', jobId: 'j', phase: 'save', ratio: 0.5 })).toBe(
      false,
    );
    expect(isEngineToWorker({ t: 'engine/fetched', jobId: 'j', resumable: false })).toBe(true);
    expect(
      isEngineToWorker({
        t: 'engine/result',
        jobId: 'j',
        url: 'blob:x',
        bytes: 1,
        mime: 'video/mp4',
      }),
    ).toBe(true);
    expect(
      isEngineToWorker({
        t: 'engine/error',
        jobId: 'j',
        error: { code: 'network' },
        resumable: true,
      }),
    ).toBe(true);
    expect(isEngineToWorker({ t: 'engine/error', jobId: 'j', resumable: true })).toBe(false);
  });
});
