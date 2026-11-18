import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureServer, type FixtureServer } from './fixture-server';
import { launchExtension, type Launched } from './harness';

let fx: FixtureServer;
let ext: Launched;
beforeAll(async () => {
  fx = await createFixtureServer({ size: 400_000 });
  ext = await launchExtension();
}, 60_000);
afterAll(async () => {
  await ext?.close();
  await fx?.stop();
});

describe('extension in real Chrome', () => {
  it('lists the fixture video and downloads a byte-identical file', async () => {
    const page = await ext.visit(fx.pageUrl());
    const popup = await ext.openPopup(page);
    await popup.getByRole('button', { name: 'Download', exact: true }).first().click();
    const worker = await ext.getWorker();
    const file = await worker.evaluate(async () => {
      for (let i = 0; i < 100; i++) {
        const [d] = await chrome.downloads.search({ state: 'complete' });
        if (d) return d.filename;
        await new Promise((r) => setTimeout(r, 200));
      }
      return undefined;
    });
    expect(file).toBeTruthy();
    const got = createHash('sha256').update(readFileSync(file!)).digest('hex');
    expect(got).toBe(fx.sha256());
  });
});
