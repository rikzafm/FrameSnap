/**
 * In-memory CDN for fetch-loop tests: byte ranges, ETag/If-Range, signed URLs
 * that expire, scripted failures, and a request log.
 */
import type { HttpGet } from "../../src/core/jobs/fetch-loop";

export interface FakeFile {
  body: Uint8Array;
  etag?: string;
  acceptRanges?: boolean;
}

export interface Logged {
  path: string;
  range?: string;
  ifRange?: string;
  status: number;
}

export class FakeCdn {
  files = new Map<string, FakeFile>();
  log: Logged[] = [];
  /** Valid signature tokens (?sig=...). Absent sig = always valid. */
  validSigs = new Set<string>();
  /** Return a status for a request instead of serving it (once per entry). */
  failures: ((path: string, n: number) => number | "network" | undefined)[] = [];
  private count = 0;

  put(path: string, file: FakeFile): this {
    this.files.set(path, { acceptRanges: true, ...file });
    return this;
  }

  bytesServed(path?: string): number {
    return this.log
      .filter((l) => l.status === 206 || l.status === 200)
      .filter((l) => !path || l.path === path)
      .reduce((s, l) => {
        if (!l.range) return s + (this.files.get(l.path)?.body.byteLength ?? 0);
        const [a, b] = l.range.replace("bytes=", "").split("-").map(Number);
        return s + (b! - a! + 1);
      }, 0);
  }

  http: HttpGet = async (url, { headers, signal }) => {
    if (signal.aborted) throw signal.reason;
    const u = new URL(url);
    const path = u.pathname;
    const n = this.count++;
    const range = headers.Range;
    const ifRange = headers["If-Range"];
    const entry: Logged = { path, range, ifRange, status: 0 };
    this.log.push(entry);

    for (const f of this.failures) {
      const r = f(path, n);
      if (r === "network") {
        entry.status = -1;
        throw new TypeError("Failed to fetch");
      }
      if (r !== undefined) {
        entry.status = r;
        return new Response(null, { status: r });
      }
    }
    const sig = u.searchParams.get("sig");
    if (sig !== null && !this.validSigs.has(sig)) {
      entry.status = 403;
      return new Response(null, { status: 403 });
    }
    const file = this.files.get(path);
    if (!file) {
      entry.status = 404;
      return new Response(null, { status: 404 });
    }
    const total = file.body.byteLength;
    const etagHeaders: Record<string, string> = file.etag ? { ETag: file.etag } : {};
    const rangeOk = range && file.acceptRanges && (!ifRange || ifRange === file.etag);
    if (rangeOk) {
      const [a, b] = range.replace("bytes=", "").split("-").map(Number);
      const end = Math.min(b!, total - 1);
      entry.status = 206;
      return new Response(file.body.slice(a!, end + 1), {
        status: 206,
        headers: { ...etagHeaders, "Content-Range": `bytes ${a}-${end}/${total}`, "Accept-Ranges": "bytes" },
      });
    }
    entry.status = 200;
    return new Response(file.body.slice(), { status: 200, headers: { ...etagHeaders, "Content-Length": String(total) } });
  };
}

export function bytes(n: number, seed = 1): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

export const noSleep = async () => undefined;

/** Fast byte equality (vitest's deep equal is per element and very slow on MBs). */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
