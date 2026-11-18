import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createFixtureServer, type FixtureServer } from '../e2e/fixture-server';

let server: FixtureServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('fixture server', () => {
  it('serves the whole file whose hash it reports', async () => {
    server = await createFixtureServer({ size: 50_000 });
    const res = await fetch(server.mediaUrl());
    expect(res.status).toBe(200);
    expect(sha(new Uint8Array(await res.arrayBuffer()))).toBe(server.sha256());
  });

  it('serves byte ranges with 206', async () => {
    server = await createFixtureServer({ size: 50_000 });
    const full = new Uint8Array(await (await fetch(server.mediaUrl())).arrayBuffer());
    const res = await fetch(server.mediaUrl(), { headers: { Range: 'bytes=100-199' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/50000');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(full.slice(100, 200));
  });

  it('rejects an old signature after rotation', async () => {
    server = await createFixtureServer({ size: 1000 });
    const old = server.mediaUrl();
    server.rotateSignature();
    expect((await fetch(old)).status).toBe(403);
    expect((await fetch(server.mediaUrl())).status).toBe(200);
  });

  it('drops the connection at a byte offset, once', async () => {
    server = await createFixtureServer({ size: 200_000 });
    server.dropAt(60_000);
    await expect(fetch(server.mediaUrl()).then((r) => r.arrayBuffer())).rejects.toThrow();
    const again = await fetch(server.mediaUrl());
    expect((await again.arrayBuffer()).byteLength).toBe(200_000);
  });

  it('answers a stale If-Range with the full body after the ETag changed', async () => {
    server = await createFixtureServer({ size: 5000 });
    const etag = (await fetch(server.mediaUrl())).headers.get('etag')!;
    server.changeEtag();
    const res = await fetch(server.mediaUrl(), {
      headers: { Range: 'bytes=10-19', 'If-Range': etag },
    });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(5000);
  });

  it('rotates the signature itself once enough bytes have been served', async () => {
    server = await createFixtureServer({ size: 100_000 });
    server.rotateAfterBytes(100_000);
    const old = server.mediaUrl();
    await (await fetch(old, { headers: { Range: 'bytes=0-99999' } })).arrayBuffer();
    expect((await fetch(old)).status).toBe(403);
    expect((await fetch(server.mediaUrl())).status).toBe(200);
  });

  it('serves a given body and its hash', async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    server = await createFixtureServer({ body });
    const got = new Uint8Array(await (await fetch(server.mediaUrl())).arrayBuffer());
    expect(got).toEqual(body);
    expect(server.sha256()).toBe(sha(body));
  });

  it('serves a page with a video pointing at the current signed URL', async () => {
    server = await createFixtureServer({ size: 1000 });
    const html = await (await fetch(server.pageUrl())).text();
    expect(html).toContain(`<video`);
    expect(html).toContain(new URL(server.mediaUrl()).search);
  });
});
