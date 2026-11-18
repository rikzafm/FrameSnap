/**
 * Chunk store contract. The offscreen document backs it with OPFS
 * (src/offscreen/opfs-chunk-store.ts); tests and the no-quota fallback use
 * MemoryChunkStore. A chunk is visible to list()/read() only once write() has
 * fully completed, so a crash mid-write never leaves a half chunk behind.
 */

export interface StoredJob {
  jobId: string;
  bytes: number;
  /** ms since epoch of the newest write. */
  updatedAt: number;
}

export interface ChunkStore {
  /** key → size in bytes, for committed chunks. */
  list(jobId: string, trackId: string): Promise<Map<string, number>>;
  write(jobId: string, trackId: string, key: string, data: Uint8Array): Promise<void>;
  read(jobId: string, trackId: string, key: string): Promise<Blob>;
  deleteJob(jobId: string): Promise<void>;
  jobs(): Promise<StoredJob[]>;
}

export class MemoryChunkStore implements ChunkStore {
  private readonly data = new Map<string, Map<string, Map<string, Uint8Array>>>();
  private readonly touched = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async list(jobId: string, trackId: string): Promise<Map<string, number>> {
    const track = this.data.get(jobId)?.get(trackId);
    return new Map([...(track ?? new Map<string, Uint8Array>())].map(([k, v]) => [k, v.byteLength]));
  }

  async write(jobId: string, trackId: string, key: string, data: Uint8Array): Promise<void> {
    let job = this.data.get(jobId);
    if (!job) this.data.set(jobId, (job = new Map()));
    let track = job.get(trackId);
    if (!track) job.set(trackId, (track = new Map()));
    track.set(key, data.slice());
    this.touched.set(jobId, this.now());
  }

  async read(jobId: string, trackId: string, key: string): Promise<Blob> {
    const bytes = this.data.get(jobId)?.get(trackId)?.get(key);
    if (!bytes) throw new Error(`chunk not found: ${jobId}/${trackId}/${key}`);
    return new Blob([bytes as Uint8Array<ArrayBuffer>]);
  }

  async deleteJob(jobId: string): Promise<void> {
    this.data.delete(jobId);
    this.touched.delete(jobId);
  }

  async jobs(): Promise<StoredJob[]> {
    return [...this.data].map(([jobId, tracks]) => ({
      jobId,
      bytes: [...tracks.values()].reduce((s, t) => s + [...t.values()].reduce((x, c) => x + c.byteLength, 0), 0),
      updatedAt: this.touched.get(jobId) ?? 0,
    }));
  }
}

/** Concatenate a track's chunks in plan order into one Blob (disk-backed with OPFS). */
export async function assembleTrack(store: ChunkStore, jobId: string, trackId: string, keys: readonly string[], type = ""): Promise<Blob> {
  const parts: Blob[] = [];
  for (const key of keys) parts.push(await store.read(jobId, trackId, key));
  return new Blob(parts, { type });
}
