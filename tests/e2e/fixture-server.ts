/**
 * Fixture site for the Playwright e2e suite. Serves a page with one video and a media file
 * with Range/If-Range support, a signature that can be rotated, an ETag that can be changed,
 * and a one-shot connection drop at a chosen byte offset.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureOptions {
  size?: number;
  /** Serve these exact bytes instead of generated ones (a real, playable clip). */
  body?: Uint8Array;
  /** Bytes per write; small enough that a drop point is honoured closely. */
  writeChunk?: number;
}

export interface FixtureServer {
  origin: string;
  pageUrl(): string;
  mediaUrl(): string;
  sha256(): string;
  rotateSignature(): void;
  changeEtag(): void;
  /** Destroy the next media response after this many body bytes (once). Null clears it. */
  dropAt(offset: number | null): void;
  /** Rotate the signature once this many body bytes have been written in total (once). */
  rotateAfterBytes(n: number | null): void;
  requests: { range?: string; ifRange?: string; status: number }[];
  stop(): Promise<void>;
}

/** Deterministic, incompressible-looking body. */
export function makeBody(size: number): Uint8Array {
  const out = new Uint8Array(size);
  let x = 0x9e3779b9;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

export async function createFixtureServer(opts: FixtureOptions): Promise<FixtureServer> {
  const body = opts.body ?? makeBody(opts.size ?? 0);
  const chunk = opts.writeChunk ?? 8192;
  const hash = createHash('sha256').update(body).digest('hex');
  let sigN = 1;
  let etagN = 1;
  let drop: number | null = null;
  let rotateAt: number | null = null;
  let served = 0;
  const requests: FixtureServer['requests'] = [];
  const sig = () => `s${sigN}`;
  const etag = () => `"fx-${etagN}"`;

  const send = (
    res: ServerResponse,
    from: number,
    to: number,
    drops: number | null,
    counts: boolean,
  ) =>
    new Promise<void>((resolve) => {
      let at = from;
      const step = () => {
        if (res.destroyed) return resolve();
        if (drops !== null && at - from >= drops) {
          res.destroy();
          return resolve();
        }
        if (at > to) {
          res.end();
          return resolve();
        }
        let end = Math.min(at + chunk, to + 1);
        if (drops !== null) end = Math.min(end, from + drops);
        const n = end - at;
        res.write(body.subarray(at, end), () => {
          if (counts) served += n;
          if (counts && rotateAt !== null && served >= rotateAt) {
            rotateAt = null;
            sigN++;
          }
          at = end;
          setImmediate(step);
        });
      };
      step();
    });

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/') {
      res.setHeader('content-type', 'text/html');
      res.end(
        `<!doctype html><title>Fixture</title><body><video id="v" controls width="320" height="180" src="/media.mp4?sig=${sig()}"></video></body>`,
      );
      return;
    }
    if (url.pathname !== '/media.mp4') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const range = req.headers.range;
    const ifRange = req.headers['if-range'] as string | undefined;
    const log = { range, ifRange, status: 0 };
    requests.push(log);
    if (url.searchParams.get('sig') !== sig()) {
      log.status = 403;
      res.statusCode = 403;
      res.end('expired');
      return;
    }
    res.setHeader('content-type', 'video/mp4');
    res.setHeader('accept-ranges', 'bytes');
    res.setHeader('etag', etag());
    res.setHeader('access-control-allow-origin', '*');
    let from = 0;
    let to = body.length - 1;
    let status = 200;
    const m = /^bytes=(\d+)-(\d*)$/.exec(range ?? '');
    if (m && (!ifRange || ifRange === etag())) {
      from = Number(m[1]);
      to = m[2] ? Math.min(Number(m[2]), to) : to;
      status = 206;
      res.setHeader('content-range', `bytes ${from}-${to}/${body.length}`);
    }
    log.status = status;
    res.statusCode = status;
    res.setHeader('content-length', String(to - from + 1));
    const isVideoEl = req.headers['sec-fetch-dest'] === 'video';
    const drops = isVideoEl ? null : drop;
    if (!isVideoEl) drop = null;
    // the page's own <video> element reads the file too; only downloads count towards rotation
    void send(res, from, to, drops, !isVideoEl);
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    pageUrl: () => `${origin}/`,
    mediaUrl: () => `${origin}/media.mp4?sig=${sig()}`,
    sha256: () => hash,
    rotateSignature: () => void sigN++,
    changeEtag: () => void etagN++,
    dropAt: (o) => void (drop = o),
    rotateAfterBytes: (n) => {
      rotateAt = n === null ? null : served + n;
    },
    requests,
    stop: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
