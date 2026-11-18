import { afterEach, describe, expect, it, vi } from 'vitest';
import { assembleTrack } from '../../src/core/jobs/store';
import { OpfsChunkStore } from '../../src/offscreen/opfs-chunk-store';

const store = new OpfsChunkStore();
const jobId = `test-${Math.random().toString(36).slice(2)}`;
const bytes = (n: number, v: number) => new Uint8Array(n).fill(v);
const text = async (b: Blob) => [...new Uint8Array(await b.arrayBuffer())];

async function trackDir() {
  const root = await navigator.storage.getDirectory();
  const jobs = await root.getDirectoryHandle('jobs');
  return (await jobs.getDirectoryHandle(jobId)).getDirectoryHandle('0');
}

afterEach(async () => {
  vi.restoreAllMocks();
  await store.deleteJob(jobId);
});

describe('OpfsChunkStore (real OPFS)', () => {
  it('write → list → read → deleteJob round trip', async () => {
    await store.write(jobId, '0', 'r0-2', bytes(3, 7));
    await store.write(jobId, '0', 'r3-5', bytes(3, 9));

    expect([...(await store.list(jobId, '0'))].sort()).toEqual([
      ['r0-2', 3],
      ['r3-5', 3],
    ]);
    expect(await text(await store.read(jobId, '0', 'r0-2'))).toEqual([7, 7, 7]);
    expect(await text(await assembleTrack(store, jobId, '0', ['r0-2', 'r3-5']))).toEqual([
      7, 7, 7, 9, 9, 9,
    ]);

    const found = (await store.jobs()).find((j) => j.jobId === jobId);
    expect(found?.bytes).toBe(6);

    await store.deleteJob(jobId);
    expect((await store.jobs()).some((j) => j.jobId === jobId)).toBe(false);
    expect((await store.list(jobId, '0')).size).toBe(0);
    await expect(store.read(jobId, '0', 'r0-2')).rejects.toThrow();
  });

  it('re-writing a chunk replaces it', async () => {
    await store.write(jobId, '0', 'k', bytes(2, 1));
    await store.write(jobId, '0', 'k', bytes(4, 2));
    expect(await text(await store.read(jobId, '0', 'k'))).toEqual([2, 2, 2, 2]);
    expect((await store.list(jobId, '0')).get('k')).toBe(4);
  });

  it('a write interrupted before close() leaves no file', async () => {
    await store.write(jobId, '0', 'good', bytes(2, 5));
    // the writable dies at close(): the interruption point the ticket names
    vi.spyOn(FileSystemWritableFileStream.prototype, 'close').mockRejectedValue(
      new DOMException('interrupted', 'AbortError'),
    );
    await expect(store.write(jobId, '0', 'broken', bytes(8, 3))).rejects.toThrow();
    vi.restoreAllMocks();

    expect([...(await store.list(jobId, '0')).keys()]).toEqual(['good']);
    await expect(store.read(jobId, '0', 'broken')).rejects.toThrow();
    const names: string[] = [];
    for await (const [name] of (await trackDir()).entries()) names.push(name);
    expect(names).toEqual(['good']);
  });

  it('an unfinished .part file (crash) is never listed as a chunk', async () => {
    await store.write(jobId, '0', 'good', bytes(2, 5));
    const w = await (
      await (await trackDir()).getFileHandle('half.part', { create: true })
    ).createWritable();
    await w.write(bytes(4, 1)); // never closed
    expect([...(await store.list(jobId, '0')).keys()]).toEqual(['good']);
    await w.abort();
  });
});
