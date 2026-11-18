import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeClip, padMp4 } from './clip';
import { createFixtureServer, type FixtureServer } from './fixture-server';
import { launchExtension, type Launched } from './harness';

let fx: FixtureServer;
let ext: Launched;
beforeAll(async () => {
  fx = await createFixtureServer({ body: padMp4(await makeClip(), 4 * 1024 * 1024) });
  ext = await launchExtension();
}, 120_000);
afterAll(async () => {
  await ext?.close();
  await fx?.stop();
});

/**
 * A completed download of this mime type. Playwright renames browser downloads to a GUID, so the
 * mime type (not the file name) says which one it is.
 */
async function waitForDownload(
  mime: string,
  ms = 90_000,
): Promise<{ filename: string; at: number } | undefined> {
  const w = await ext.getWorker();
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const found = await w.evaluate(async (type) => {
      const all = await chrome.downloads.search({ state: 'complete' });
      const d = all.find((x) => x.mime === type);
      return d ? { filename: d.filename, at: Date.parse(d.endTime!) } : undefined;
    }, mime);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

describe('frame snap (spec F4) in real Chrome', () => {
  it('saves a 1920x1080 PNG quickly while the video keeps playing', async () => {
    const page = await ext.visit(fx.pageUrl());
    await page.evaluate(async () => {
      const v = document.querySelector('video')!;
      v.muted = true;
      await v.play();
    });
    const before = await page.evaluate(() => document.querySelector('video')!.currentTime);
    const popup = await ext.openPopup(page);
    const snap = popup.getByRole('button', { name: 'Snap', exact: true }).first();
    await snap.waitFor();
    // The real popup sits over a visible page. As a tab it hides the page, and Chrome then stalls
    // frame reads from the hidden video, so bring the page back before snapping.
    await page.bringToFront();
    const clicked = Date.now();
    await snap.click();
    const got = await waitForDownload('image/png', 10_000);
    expect(got, 'a PNG download').toBeTruthy();
    const ms = got!.at - clicked;
    console.log('snap click to saved PNG ms', ms);
    const png = readFileSync(got!.filename);
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1920, 1080]);
    // Spec: 300 ms for the shortcut. This is the popup path (one more hop); measured ~150-300 ms.
    expect(ms).toBeLessThan(500);
    await new Promise((r) => setTimeout(r, 500));
    const after = await page.evaluate(() => document.querySelector('video')!.currentTime);
    expect(after).toBeGreaterThan(before);
  });
});

describe('gif export (spec F3) in real Chrome', () => {
  it('makes a 480 px, 15 fps GIF without long tasks on the page, then saves it', async () => {
    const page = await ext.visit(fx.pageUrl());
    await page.evaluate(() => {
      (window as unknown as { __long: number[] }).__long = [];
      new PerformanceObserver((l) => {
        for (const e of l.getEntries())
          (window as unknown as { __long: number[] }).__long.push(e.duration);
      }).observe({ type: 'longtask', buffered: true });
    });
    const popup = await ext.openPopup(page);
    await popup.getByRole('tab', { name: 'GIF' }).click();
    await popup.getByRole('radio', { name: '15' }).click();
    await popup.getByRole('radio', { name: '480' }).click();
    await popup.getByRole('button', { name: 'Make GIF' }).click();
    await popup.getByRole('button', { name: /^Save / }).waitFor({ timeout: 120_000 });
    await popup.getByRole('button', { name: /^Save / }).click();
    const got = await waitForDownload('image/gif', 20_000);
    expect(got, 'a GIF download').toBeTruthy();
    const gif = readFileSync(got!.filename);
    expect(gif.subarray(0, 3).toString()).toBe('GIF');
    expect(gif.readUInt16LE(6)).toBe(480);
    const long = await page.evaluate(() => (window as unknown as { __long: number[] }).__long);
    expect(Math.max(0, ...long)).toBeLessThan(200);
  });
});
