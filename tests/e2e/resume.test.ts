import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import { makeClip, padMp4 } from './clip';
import { createFixtureServer, type FixtureServer } from './fixture-server';
import { launchExtension, type Launched } from './harness';

const MB = 1024 * 1024;
let fx: FixtureServer | undefined;
let ext: Launched | undefined;
afterEach(async () => {
  await ext?.close();
  await fx?.stop();
  ext = fx = undefined;
});

const jobStatuses = (e: Launched) =>
  e.getWorker().then((w) =>
    w.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      return Object.entries(all)
        .filter(([k]) => k.startsWith('job:') || k.startsWith('jobs/') || k.includes('job'))
        .map(([k, v]) => ({ k, status: (v as { status?: string })?.status }));
    }),
  );

async function waitFor<T>(
  fn: () => Promise<T | undefined | false>,
  what: string,
  ms = 60_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function completedFile(e: Launched): Promise<string | undefined> {
  const w = await e.getWorker();
  return w.evaluate(
    async () => (await chrome.downloads.search({ state: 'complete' }))[0]?.filename,
  );
}

const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

async function startAndExpire(e: Launched, f: FixtureServer): Promise<Page> {
  const page = await e.visit(f.pageUrl());
  const popup = await e.openPopup(page);
  await popup.getByRole('button', { name: 'Download video', exact: true }).first().click();
  await waitFor(async () => {
    const s = await jobStatuses(e);
    return s.some((j) => j.status === 'failed') || undefined;
  }, 'the job to fail when the signature expires');
  await popup.close();
  return page;
}

describe('resume in real Chrome (spec section 9)', () => {
  it('expired signature mid-download, page reload, resume: identical file, only missing bytes fetched', async () => {
    fx = await createFixtureServer({ body: padMp4(await makeClip(), 64 * MB) });
    fx.rotateAfterBytes(28 * MB);
    ext = await launchExtension();
    const page = await startAndExpire(ext, fx);
    const fetchedBefore = fx.requests.filter((r) => r.status === 206 || r.status === 200).length;
    expect(fetchedBefore).toBeGreaterThan(0);
    const requestsBefore = fx.requests.length;

    await page.reload(); // the page now carries the new signed URL
    const popup = await ext.openPopup(page);
    await popup
      .getByRole('button', { name: /^Resume/ })
      .first()
      .click();
    const file = await waitFor(() => completedFile(ext!), 'the resumed download to complete');
    expect(sha(file)).toBe(fx.sha256());
    // the resumed fetches used If-Range, and only the chunks that were missing were requested
    const span = (r: { range?: string }) => {
      const [a, b] = r.range!.replace('bytes=', '').split('-').map(Number);
      return b! - a! + 1;
    };
    const resumed = fx.requests.slice(requestsBefore).filter((r) => r.ifRange && r.status === 206);
    expect(resumed.length).toBeGreaterThan(0);
    expect(resumed.reduce((n, r) => n + span(r), 0)).toBeLessThanOrEqual(24 * MB);
  });

  it('a changed file (new ETag) restarts from zero instead of mixing bytes', async () => {
    fx = await createFixtureServer({ body: padMp4(await makeClip(), 64 * MB) });
    fx.rotateAfterBytes(28 * MB);
    ext = await launchExtension();
    const page = await startAndExpire(ext, fx);
    fx.changeEtag();
    const requestsBefore = fx.requests.length;
    await page.reload();
    const popup = await ext.openPopup(page);
    await popup
      .getByRole('button', { name: /^Resume/ })
      .first()
      .click();
    const file = await waitFor(() => completedFile(ext!), 'the restarted download to complete');
    expect(sha(file)).toBe(fx.sha256());
    const refetched = fx.requests
      .slice(requestsBefore)
      .filter((r) => r.range && r.range !== 'bytes=0-0' && r.status === 206 && r.ifRange)
      .reduce((n, r) => {
        const [a, b] = r.range!.replace('bytes=', '').split('-').map(Number);
        return n + (b! - a! + 1);
      }, 0);
    expect(refetched).toBeGreaterThanOrEqual(60 * MB);
  });

  it('survives a browser relaunch', async () => {
    fx = await createFixtureServer({ body: padMp4(await makeClip(), 64 * MB) });
    fx.rotateAfterBytes(28 * MB);
    ext = await launchExtension();
    const profile = ext.userDataDir;
    await startAndExpire(ext, fx);
    await ext.close(true);

    ext = await launchExtension({ userDataDir: profile });
    const page = await ext.visit(fx.pageUrl());
    const popup = await ext.openPopup(page);
    await popup
      .getByRole('button', { name: /^Resume/ })
      .first()
      .click();
    const file = await waitFor(() => completedFile(ext!), 'the resumed download to complete');
    expect(sha(file)).toBe(fx.sha256());
  });
});
