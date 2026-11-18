/**
 * Wires the service-worker download orchestrator to the real offscreen engine
 * host in one process: fake CDN for bytes, a concatenating stand-in for
 * ffmpeg, in-memory job storage, and recording fakes for chrome.downloads and
 * declarativeNetRequest.
 */
import { createDownloadOrchestrator, type DownloadDelta, type HistoryEntry } from "../../src/background/download";
import { createJobStore, type StorageAreaLike } from "../../src/background/job-store";
import { createEngineLifecycle } from "../../src/background/engine-lifecycle";
import type { WorkerToEngine } from "../../src/core/engine-messages";
import type { JobEvent, WorkerToContent } from "../../src/core/messages";
import { parseMedia } from "../../src/core/media/hls";
import { parseMpd } from "../../src/core/media/dash";
import { MemoryChunkStore } from "../../src/core/jobs/store";
import type { DownloadOptions, VideoSource } from "../../src/core/model";
import type { FfmpegBackend } from "../../src/offscreen/backend";
import { Engine } from "../../src/offscreen/engine";
import { createEngineHost } from "../../src/offscreen/host";
import { FakeCdn, noSleep } from "./fake-cdn";

/** "ffmpeg" that writes the concatenation of its inputs, so tests can see what was assembled. */
export class ConcatBackend implements FfmpegBackend {
  files = new Map<string, Uint8Array>();
  commands: string[][] = [];
  async load() {}
  async writeFile(p: string, d: Uint8Array) {
    this.files.set(p, d);
  }
  async readFile(p: string) {
    return this.files.get(p) ?? new Uint8Array();
  }
  async deleteFile(p: string) {
    this.files.delete(p);
  }
  /** Stall ffmpeg until this resolves. */
  hold?: Promise<void>;
  async exec(args: string[]) {
    this.commands.push(args);
    await this.hold;
    const inputs = args.flatMap((a, i) => (args[i - 1] === "-i" ? [a] : []));
    const parts = inputs.map((i) => this.files.get(i) ?? new Uint8Array());
    const out = new Uint8Array(parts.reduce((s, p) => s + p.byteLength, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    this.files.set(args[args.length - 1]!, out);
    return 0;
  }
  onProgress() {}
  terminate() {}
}

export function memoryArea(): StorageAreaLike & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return structuredClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
  };
}

export interface Saved {
  id: number;
  url: string;
  filename: string;
  blob?: Blob;
}

export function createHarness(opts: { sources?: VideoSource[]; files?: Record<string, string> } = {}) {
  const cdn = new FakeCdn();
  const backend = new ConcatBackend();
  const store = new MemoryChunkStore();
  const area = memoryArea();
  const events: JobEvent[] = [];
  const sent: WorkerToEngine[] = [];
  const history: HistoryEntry[] = [];
  const blobs = new Map<string, Blob>();
  const saved: Saved[] = [];
  const erased: number[] = [];
  const removedFiles: number[] = [];
  const resumed: number[] = [];
  const canResume = new Map<number, boolean>();
  const rules = new Map<number, chrome.declarativeNetRequest.Rule>();
  const ruleLog: string[] = [];
  const captureSent: { tabId: number; frameId: number; msg: WorkerToContent }[] = [];
  const textFiles = new Map<string, string>(Object.entries(opts.files ?? {}));
  let seq = 0;
  let ids = 0;
  let dlIds = 0;
  let clock = 1_000_000;
  /** Return a promise to stall a request (cancel-at-50 % tests). */
  let gate: ((url: string, n: number) => Promise<void> | undefined) | undefined;
  let requests = 0;

  const fetcher = async (url: string, init: { method?: string; headers: Record<string, string>; signal: AbortSignal }) => {
    const text = textFiles.get(url);
    if (text !== undefined) return new Response(text, { status: 200 });
    const wait = gate?.(url, requests++);
    if (wait) {
      await Promise.race([
        wait,
        new Promise<never>((_, reject) => {
          if (init.signal.aborted) reject(new DOMException("aborted", "AbortError"));
          init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
      ]);
    }
    return cdn.http(url, { headers: init.headers, signal: init.signal });
  };

  const host = createEngineHost({
    send: (m) => void orch.onEngineMessage(m),
    opfs: () => store,
    memory: new MemoryChunkStore(),
    engine: new Engine(backend),
    http: (url, init) => fetcher(url, init),
    blobUrls: {
      create: (b) => {
        const u = `blob:test/${seq++}`;
        blobs.set(u, b);
        return u;
      },
      revoke: (u) => void blobs.delete(u),
    },
    storage: { persist: async () => true, estimate: async () => ({ usage: 0, quota: 1e12 }) },
    fetchTuning: { sleep: noSleep, backoffMs: 0 },
  });

  let created = 0;
  const lifecycle = createEngineLifecycle({
    api: {
      has: async () => created > 0,
      create: async () => void created++,
      close: async () => void (created = 0),
    },
    url: "offscreen.html",
  });

  const jobs = createJobStore({ area, now: () => clock, intervalMs: 5 });

  const orch = createDownloadOrchestrator({
    jobs,
    engine: {
      send: async (m) => {
        await lifecycle.ensure();
        sent.push(m);
        void host.handle(m);
      },
    },
    lifecycle,
    downloads: {
      download: async (o) => {
        const id = ++dlIds;
        saved.push({ id, url: o.url, filename: o.filename, blob: blobs.get(o.url) });
        return id;
      },
      search: async ({ id }) => {
        const s = saved.find((x) => x.id === id);
        return s ? [{ id, filename: `C:\\Downloads\\${s.filename}`, canResume: canResume.get(id) ?? false }] : [];
      },
      resume: async (id) => void resumed.push(id),
      cancel: async () => undefined,
      removeFile: async (id) => void removedFiles.push(id),
      erase: async ({ id }) => void erased.push(id),
    },
    dnr: {
      getSessionRules: async () => [...rules.values()],
      updateSessionRules: async ({ addRules = [], removeRuleIds = [] }) => {
        for (const id of removeRuleIds) {
          rules.delete(id);
          ruleLog.push(`remove:${id}`);
        }
        for (const r of addRules) {
          rules.set(r.id, r);
          ruleLog.push(`add:${r.id}`);
        }
      },
    },
    fetch: fetcher,
    parseMedia,
    parseMpd,
    capture: { send: async (tabId, frameId, msg) => void captureSent.push({ tabId, frameId, msg }) },
    lookupSource: async (_tab, id) => opts.sources?.find((s) => s.id === id),
    history: { add: async (e) => void history.push(e) },
    emit: (e) => events.push(e),
    now: () => (clock += 10),
    newId: () => `job${++ids}`,
  });

  return {
    orch,
    cdn,
    backend,
    store,
    area,
    jobs,
    events,
    sent,
    captureSent,
    history,
    saved,
    blobs,
    erased,
    removedFiles,
    resumed,
    canResume,
    rules,
    ruleLog,
    lifecycle,
    setGate(g: typeof gate) {
      gate = g;
    },
    /** Chrome reports a finished download. */
    complete(id: number) {
      orch.onDownloadChanged({ id, state: { current: "complete" } } satisfies DownloadDelta);
    },
    interrupt(id: number, error = "NETWORK_FAILED") {
      orch.onDownloadChanged({ id, state: { current: "interrupted" }, error: { current: error } });
    },
    async download(sourceId: string, options: Partial<DownloadOptions> = {}) {
      return orch.download({ tabId: 1, sourceId, options: { format: "mp4", quality: "best", audio: "keep", filenameTemplate: "{title}", ...options } });
    },
    /** Resolves with the job's first terminal event. */
    async finished(jobId: string, timeout = 5000): Promise<JobEvent> {
      const t0 = Date.now();
      for (;;) {
        const last = events.find((e) => e.jobId === jobId && e.t !== "progress" && e.t !== "queued");
        if (last) return last;
        if (Date.now() - t0 > timeout) throw new Error(`job ${jobId} did not finish: ${JSON.stringify(events.slice(-5))}`);
        await new Promise((r) => setTimeout(r, 1));
      }
    },
    async until(pred: () => boolean, timeout = 5000) {
      const t0 = Date.now();
      while (!pred()) {
        if (Date.now() - t0 > timeout) throw new Error("until: timed out");
        await new Promise((r) => setTimeout(r, 1));
      }
    },
  };
}

export type Harness = ReturnType<typeof createHarness>;

export function progressive(id: string, over: Partial<VideoSource> = {}, variant: Partial<VideoSource["variants"][number]> = {}): VideoSource {
  return {
    id,
    site: "generic",
    title: `Clip ${id}`,
    pageUrl: "https://p.test/watch",
    duration: 10,
    variants: [
      {
        id: `${id}-v`,
        kind: "progressive",
        url: `https://cdn.test/${id}.mp4`,
        container: "mp4",
        hasAudio: true,
        videoCodec: "avc1.64001f",
        audioCodec: "mp4a.40.2",
        height: 720,
        acceptsRanges: true,
        ...variant,
      },
    ],
    audioTracks: [],
    protection: "none",
    detectedBy: ["network"],
    ...over,
  };
}
