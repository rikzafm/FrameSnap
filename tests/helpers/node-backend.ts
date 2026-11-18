import { Worker } from "node:worker_threads";
import type { FfmpegBackend } from "../../src/offscreen/backend";

const WORKER = new URL("./node-core-worker.mjs", import.meta.url);

interface Pending {
  resolve: (v: never) => void;
  reject: (e: Error) => void;
}

/** FfmpegBackend over a worker thread, so terminate() really kills a running encode. */
export class NodeBackend implements FfmpegBackend {
  private worker?: Worker;
  private next = 0;
  private pending = new Map<number, Pending>();
  private progress: (r: number) => void = () => {};
  loads = 0;

  private call<T>(type: string, args?: unknown): Promise<T> {
    const w = this.worker;
    if (!w) return Promise.reject(new Error("not loaded"));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      w.postMessage({ id, type, args });
    });
  }

  async load(): Promise<void> {
    this.loads++;
    const w = (this.worker = new Worker(WORKER));
    w.on("message", (m: { id?: number; data?: unknown; error?: string; progress?: number }) => {
      if (m.id === undefined) return this.progress(m.progress ?? 0);
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (m.error) p?.reject(new Error(m.error));
      else p?.resolve(m.data as never);
    });
    await this.call("load");
  }
  async writeFile(path: string, data: Uint8Array) {
    await this.call("write", { path, data });
  }
  readFile(path: string) {
    return this.call<Uint8Array>("read", { path });
  }
  async deleteFile(path: string) {
    await this.call("delete", { path });
  }
  exec(args: string[]) {
    return this.call<number>("exec", { args });
  }
  onProgress(cb: (r: number) => void) {
    this.progress = cb;
  }
  terminate() {
    void this.worker?.terminate();
    this.worker = undefined;
    for (const p of this.pending.values()) p.reject(new Error("terminated"));
    this.pending.clear();
  }
}
