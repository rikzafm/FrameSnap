import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpfsChunkStore } from '../../src/offscreen/opfs-chunk-store';

interface FakeFile {
  bytes: Uint8Array;
  lastModified: number;
}

function makeFakeOpfs(options: { supportMove: boolean; failWrite?: boolean }) {
  const dirs = new Map<string, FakeDir>();

  class FakeWritable {
    private chunks: Uint8Array[] = [];
    constructor(private readonly commit: (bytes: Uint8Array) => void) {}
    async write(data: Uint8Array) {
      if (options.failWrite) throw new Error('disk full');
      this.chunks.push(new Uint8Array(data));
    }
    async close() {
      const total = this.chunks.reduce((n, c) => n + c.length, 0);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of this.chunks) {
        out.set(c, off);
        off += c.length;
      }
      this.commit(out);
    }
    async abort() {}
  }

  class FakeFileHandle {
    readonly kind = 'file' as const;
    move?: (name: string) => Promise<void>;
    constructor(
      public name: string,
      private readonly parent: FakeDir,
    ) {
      if (options.supportMove) {
        this.move = async (nextName: string) => {
          const data = this.parent.files.get(this.name);
          if (!data) throw new DOMException('missing', 'NotFoundError');
          this.parent.files.delete(this.name);
          this.parent.files.set(nextName, data);
          this.name = nextName;
        };
      }
    }
    async getFile() {
      const f = this.parent.files.get(this.name)!;
      return new File([f.bytes as Uint8Array<ArrayBuffer>], this.name, { lastModified: f.lastModified });
    }
    async createWritable() {
      return new FakeWritable((bytes) => {
        this.parent.files.set(this.name, { bytes, lastModified: Date.now() });
      });
    }
  }

  class FakeDir {
    readonly kind = 'directory' as const;
    readonly subdirs = new Map<string, FakeDir>();
    readonly files = new Map<string, FakeFile>();
    constructor(readonly path: string) {
      dirs.set(path, this);
    }
    async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
      const hit = this.subdirs.get(name);
      if (hit) return hit;
      if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
      const created = new FakeDir(`${this.path}/${name}`);
      this.subdirs.set(name, created);
      return created;
    }
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      if (!this.files.has(name)) {
        if (!opts?.create) throw new DOMException('not found', 'NotFoundError');
        this.files.set(name, { bytes: new Uint8Array(), lastModified: Date.now() });
      }
      return new FakeFileHandle(name, this);
    }
    async removeEntry(name: string) {
      if (!this.files.delete(name) && !this.subdirs.delete(name)) {
        throw new DOMException('not found', 'NotFoundError');
      }
    }
    async *entries(): AsyncIterableIterator<[string, FakeDir | FakeFileHandle]> {
      for (const [k, d] of this.subdirs) yield [k, d];
      for (const k of this.files.keys()) yield [k, new FakeFileHandle(k, this)];
    }
  }

  const root = new FakeDir('');
  vi.stubGlobal('navigator', {
    storage: {
      getDirectory: async () => root,
    },
  });
  return { root, dirs };
}

describe('OpfsChunkStore', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes atomically via .part and move() when move is supported (Chrome)', async () => {
    const { dirs } = makeFakeOpfs({ supportMove: true });
    const store = new OpfsChunkStore();
    const payload = new Uint8Array([1, 2, 3, 4]);
    await store.write('job1', 'v', '0000', payload);

    const trackDir = dirs.get('/jobs/job1/v')!;
    expect([...trackDir.files.keys()]).toEqual(['0000']);
    const listed = await store.list('job1', 'v');
    expect(listed.get('0000')).toBe(4);
    const read = new Uint8Array(await (await store.read('job1', 'v', '0000')).arrayBuffer());
    expect(read).toEqual(payload);
  });

  it('falls back to writing the target handle directly when move() is absent (Firefox)', async () => {
    const { dirs } = makeFakeOpfs({ supportMove: false });
    const store = new OpfsChunkStore();
    const a = new Uint8Array([10, 20, 30]);
    const b = new Uint8Array([40, 50]);
    await store.write('job1', 'v', '0000', a);
    await store.write('job1', 'v', '0001', b);

    const trackDir = dirs.get('/jobs/job1/v')!;
    expect([...trackDir.files.keys()].sort()).toEqual(['0000', '0001']);
    expect(new Uint8Array(await (await store.read('job1', 'v', '0000')).arrayBuffer())).toEqual(a);
    expect(new Uint8Array(await (await store.read('job1', 'v', '0001')).arrayBuffer())).toEqual(b);
  });

  it('removes an incomplete chunk file on write failure when move() is absent', async () => {
    const { dirs } = makeFakeOpfs({ supportMove: false, failWrite: true });
    const store = new OpfsChunkStore();
    await expect(store.write('job1', 'v', '0000', new Uint8Array([1, 2]))).rejects.toThrow(
      'disk full',
    );
    const trackDir = dirs.get('/jobs/job1/v')!;
    expect([...trackDir.files.keys()]).toEqual([]);
    expect((await store.list('job1', 'v')).size).toBe(0);
  });
});
