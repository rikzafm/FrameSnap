/**
 * The resumable fetch phase.
 *
 *   1. Reconcile: the chunk store is the truth. A key the job record lists but
 *      the store lacks (or holds at the wrong size) is fetched again; a key
 *      the store holds but the record missed (crash before the record was
 *      saved) is accepted.
 *   2. Fetch every missing chunk with a small worker pool, in plan order.
 *      Byte ranges carry If-Range, so a server whose file changed answers
 *      200 instead of 206 and the job stops with "changed" instead of
 *      stitching two different files together.
 *   3. Verify size, decrypt HLS AES-128, write to the store, then report the
 *      commit so the caller can persist the job record.
 *
 * Network errors and 5xx retry with exponential backoff. 401/403/404/410 mean
 * the signed URL expired: no retry, the job fails as resumable and the
 * resume flow re-detects fresh URLs.
 */
import { FrameSnapError, httpError } from "../errors";
import { hexToBytes, type ChunkSpec, type TrackPlan } from "./chunks";
import { ifRangeValue, type TrackValidators } from "./source-ref";
import type { ChunkStore } from "./store";

export type HttpGet = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface FetchPhaseOptions {
  jobId: string;
  tracks: readonly TrackPlan[];
  store: ChunkStore;
  http: HttpGet;
  /** Extra request headers the CDN needs (Referer/Origin) – applied by the caller's header rules or sent here. */
  headers?: Record<string, string>;
  validators?: Readonly<Record<string, TrackValidators>>;
  signal: AbortSignal;
  concurrency?: number;
  retries?: number;
  backoffMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Called after each chunk is safely in the store. */
  onCommit?: (trackId: string, key: string, bytes: number) => void;
  /** Called after reconcile and after each commit. */
  onProgress?: (done: number, total: number) => void;
  /**
   * Byte-level progress while bodies stream in: bytes held so far (stored chunks plus the
   * partial ones in flight) and the total when every chunk size is known.
   */
  onBytes?: (bytes: number, totalBytes: number | undefined) => void;
}

export interface FetchPhaseResult {
  /** trackId → committed keys, in plan order. */
  committed: Map<string, string[]>;
  fetchedChunks: number;
  fetchedBytes: number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function decryptAes128(data: Uint8Array, key: CryptoKey, ivHex: string): Promise<Uint8Array> {
  const out = await crypto.subtle.decrypt({ name: "AES-CBC", iv: hexToBytes(ivHex) }, key, data as Uint8Array<ArrayBuffer>);
  return new Uint8Array(out);
}

async function readStreaming(body: ReadableStream<Uint8Array>, onChunk: (n: number) => void): Promise<Uint8Array> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.byteLength;
    onChunk(value.byteLength);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export async function runFetchPhase(opts: FetchPhaseOptions): Promise<FetchPhaseResult> {
  const { jobId, tracks, store, http, signal } = opts;
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const retries = opts.retries ?? 3;
  const backoffMs = opts.backoffMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;

  // 1. reconcile with what is actually on disk
  const have = new Map<string, Set<string>>();
  for (const t of tracks) {
    const stored = await store.list(jobId, t.trackId);
    const ok = new Set<string>();
    for (const c of t.chunks) {
      const size = stored.get(c.key);
      if (size !== undefined && (c.bytes === undefined || size === c.bytes)) ok.add(c.key);
    }
    have.set(t.trackId, ok);
  }

  const total = tracks.reduce((s, t) => s + t.chunks.length, 0);
  let done = [...have.values()].reduce((s, set) => s + set.size, 0);
  opts.onProgress?.(done, total);

  const knownTotal = tracks.every((t) => t.chunks.every((c) => c.bytes !== undefined))
    ? tracks.reduce((s, t) => s + t.chunks.reduce((n, c) => n + (c.bytes ?? 0), 0), 0)
    : undefined;
  let heldBytes = 0;
  for (const t of tracks) for (const c of t.chunks) if (have.get(t.trackId)!.has(c.key)) heldBytes += c.bytes ?? 0;
  const addBytes = (n: number) => {
    heldBytes += n;
    opts.onBytes?.(heldBytes, knownTotal);
  };
  if (heldBytes > 0) opts.onBytes?.(heldBytes, knownTotal);

  const queue: { track: TrackPlan; chunk: ChunkSpec }[] = [];
  for (const track of tracks) for (const chunk of track.chunks) if (!have.get(track.trackId)!.has(chunk.key)) queue.push({ track, chunk });

  // one failure stops the whole phase
  const inner = new AbortController();
  const stop = () => inner.abort(signal.reason);
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });

  const keys = new Map<string, Promise<CryptoKey>>();
  const keyFor = (url: string): Promise<CryptoKey> => {
    let p = keys.get(url);
    if (!p) {
      p = (async () => {
        const res = await http(url, { headers: { ...opts.headers }, signal: inner.signal });
        if (!res.ok) throw httpError(res.status);
        return crypto.subtle.importKey("raw", await res.arrayBuffer(), "AES-CBC", false, ["decrypt"]);
      })();
      keys.set(url, p);
    }
    return p;
  };

  let fetchedBytes = 0;
  let fetchedChunks = 0;

  const fetchOnce = async (track: TrackPlan, c: ChunkSpec): Promise<Uint8Array> => {
    const headers: Record<string, string> = { ...opts.headers };
    const validators = opts.validators?.[track.trackId];
    let sentIfRange = false;
    if (c.range) {
      headers.Range = `bytes=${c.range.start}-${c.range.end}`;
      const ifRange = ifRangeValue(validators);
      if (ifRange) {
        headers["If-Range"] = ifRange;
        sentIfRange = true;
      }
    }
    const res = await http(c.url, { headers, signal: inner.signal });
    if (!res.ok) {
      if (RETRYABLE_STATUS.has(res.status)) throw new FrameSnapError("network", `HTTP ${res.status}`);
      throw httpError(res.status);
    }
    if (c.range) {
      if (res.status !== 206) {
        // a full body for a range request: the file changed (If-Range) or ranges are not honoured
        const coversAll = c.range.start === 0 && validators?.contentLength === c.range.end + 1;
        if (sentIfRange || !coversAll) throw new FrameSnapError(sentIfRange ? "changed" : "unsupported", "server ignored the byte range");
      } else {
        const totalHeader = /\/(\d+)\s*$/.exec(res.headers.get("Content-Range") ?? "")?.[1];
        if (totalHeader && validators?.contentLength !== undefined && Number(totalHeader) !== validators.contentLength) {
          throw new FrameSnapError("changed", "file size changed");
        }
      }
    }
    let data: Uint8Array;
    let streamed = 0;
    try {
      data = opts.onBytes && res.body ? await readStreaming(res.body, (n) => ((streamed += n), addBytes(n))) : new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      addBytes(-streamed); // the attempt is thrown away: do not count it twice on retry
      throw err;
    }
    if (c.bytes !== undefined && data.byteLength !== c.bytes) addBytes(-streamed);
    if (c.bytes !== undefined && data.byteLength !== c.bytes) throw new FrameSnapError("network", `short read ${data.byteLength}/${c.bytes}`);
    if (c.decrypt) data = await decryptAes128(data, await keyFor(c.decrypt.keyUrl), c.decrypt.ivHex);
    return data;
  };

  const fetchWithRetry = async (track: TrackPlan, c: ChunkSpec): Promise<Uint8Array> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetchOnce(track, c);
      } catch (err) {
        if (inner.signal.aborted) throw inner.signal.reason ?? err;
        const transient = err instanceof TypeError || (err instanceof FrameSnapError && err.appError.code === "network");
        if (!transient || attempt >= retries) throw err;
        await sleep(backoffMs * 2 ** attempt, inner.signal);
      }
    }
  };

  let next = 0;
  let firstError: unknown;
  const worker = async () => {
    while (next < queue.length && !inner.signal.aborted) {
      const { track, chunk } = queue[next++]!;
      try {
        const data = await fetchWithRetry(track, chunk);
        await store.write(jobId, track.trackId, chunk.key, data);
        have.get(track.trackId)!.add(chunk.key);
        fetchedBytes += data.byteLength;
        fetchedChunks++;
        done++;
        opts.onCommit?.(track.trackId, chunk.key, data.byteLength);
        opts.onProgress?.(done, total);
      } catch (err) {
        if (firstError === undefined) firstError = err;
        inner.abort(err);
        return;
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  } finally {
    signal.removeEventListener("abort", stop);
  }
  if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
  if (firstError !== undefined) throw firstError;

  const committed = new Map(tracks.map((t) => [t.trackId, t.chunks.map((c) => c.key).filter((k) => have.get(t.trackId)!.has(k))]));
  return { committed, fetchedChunks, fetchedBytes };
}
