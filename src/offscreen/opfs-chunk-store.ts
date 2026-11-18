/**
 * ChunkStore on the Origin Private File System (offscreen document only).
 * Layout: /jobs/<jobId>/<trackId>/<chunkKey>
 *
 * Atomicity: a chunk is written to `<key>.part`, and only a completed close()
 * followed by a rename (`move`) gives it its real name. getFileHandle({create})
 * makes an empty file at once, so writing straight to the final name would
 * leave a bogus 0-byte chunk after an interruption. list() ignores `.part`
 * files, so "file exists" always means "chunk complete".
 */
import type { ChunkStore, StoredJob } from "../core/jobs/store";

const PART = ".part";
/** In-flight writes: our `.part`, and Chrome's own `.crswap` swap file for an open writable. */
const isTemp = (name: string) => name.endsWith(PART) || name.endsWith(".crswap");

async function dir(parent: FileSystemDirectoryHandle, name: string, create: boolean): Promise<FileSystemDirectoryHandle | undefined> {
  try {
    return await parent.getDirectoryHandle(name, { create });
  } catch (err) {
    if (!create && err instanceof DOMException && err.name === "NotFoundError") return undefined;
    throw err;
  }
}

export class OpfsChunkStore implements ChunkStore {
  private rootPromise?: Promise<FileSystemDirectoryHandle>;

  private root(): Promise<FileSystemDirectoryHandle> {
    this.rootPromise ??= navigator.storage.getDirectory().then((r) => r.getDirectoryHandle("jobs", { create: true }));
    return this.rootPromise;
  }

  private async track(jobId: string, trackId: string, create: boolean): Promise<FileSystemDirectoryHandle | undefined> {
    const job = await dir(await this.root(), jobId, create);
    return job && dir(job, trackId, create);
  }

  async list(jobId: string, trackId: string): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const t = await this.track(jobId, trackId, false);
    if (!t) return out;
    for await (const [name, handle] of t.entries()) {
      if (handle.kind === "file" && !isTemp(name)) out.set(name, (await (handle as FileSystemFileHandle).getFile()).size);
    }
    return out;
  }

  async write(jobId: string, trackId: string, key: string, data: Uint8Array): Promise<void> {
    const t = (await this.track(jobId, trackId, true))!;
    const partName = key + PART;
    const fh = await t.getFileHandle(partName, { create: true });
    try {
      const w = await fh.createWritable({ keepExistingData: false });
      try {
        await w.write(data as Uint8Array<ArrayBuffer>);
        await w.close();
      } catch (err) {
        await w.abort().catch(() => undefined);
        throw err;
      }
      await t.removeEntry(key).catch(() => undefined); // re-writing a chunk replaces it
      await (fh as FileSystemFileHandle & { move(name: string): Promise<void> }).move(key);
    } catch (err) {
      await t.removeEntry(partName).catch(() => undefined);
      throw err;
    }
  }

  async read(jobId: string, trackId: string, key: string): Promise<Blob> {
    const t = await this.track(jobId, trackId, false);
    if (!t) throw new Error(`chunk not found: ${jobId}/${trackId}/${key}`);
    // A File from OPFS is disk-backed: concatenating them does not load bytes into memory.
    return (await t.getFileHandle(key)).getFile();
  }

  async deleteJob(jobId: string): Promise<void> {
    try {
      await (await this.root()).removeEntry(jobId, { recursive: true });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "NotFoundError")) throw err;
    }
  }

  async jobs(): Promise<StoredJob[]> {
    const out: StoredJob[] = [];
    for await (const [jobId, jobHandle] of (await this.root()).entries()) {
      if (jobHandle.kind !== "directory") continue;
      let bytes = 0;
      let updatedAt = 0;
      for await (const [, trackHandle] of (jobHandle as FileSystemDirectoryHandle).entries()) {
        if (trackHandle.kind !== "directory") continue;
        for await (const [, f] of (trackHandle as FileSystemDirectoryHandle).entries()) {
          if (f.kind !== "file") continue;
          const file = await (f as FileSystemFileHandle).getFile();
          bytes += file.size;
          updatedAt = Math.max(updatedAt, file.lastModified);
        }
      }
      out.push({ jobId, bytes, updatedAt });
    }
    return out;
  }
}
