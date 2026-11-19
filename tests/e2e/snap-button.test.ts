import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
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

interface CdpNode {
  nodeId: number;
  nodeName: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
}

/** The snap button's opacity and rect. Its shadow root is closed, so DevTools reads it. */
async function snapButton(page: Page): Promise<{ opacity: number; x: number; y: number } | undefined> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root } = (await cdp.send('DOM.getDocument', { depth: -1, pierce: true })) as { root: CdpNode };
    // pierce also walks the <video> controls' UA shadow; only our host's button counts
    const find = (n: CdpNode, pred: (n: CdpNode) => boolean): CdpNode | undefined => {
      if (pred(n)) return n;
      for (const c of [...(n.shadowRoots ?? []), ...(n.children ?? [])]) {
        const hit = find(c, pred);
        if (hit) return hit;
      }
      return undefined;
    };
    const host = find(root, (n) => n.attributes?.includes('data-framesnap-snapbtn') === true);
    const btn = host && find(host, (n) => n.nodeName === 'BUTTON');
    if (!btn) return undefined;
    const { computedStyle } = (await cdp.send('CSS.getComputedStyleForNode', { nodeId: btn.nodeId })) as {
      computedStyle: { name: string; value: string }[];
    };
    const { model } = (await cdp.send('DOM.getBoxModel', { nodeId: btn.nodeId })) as { model: { content: number[] } };
    const [x1, y1, , , x3, y3] = model.content;
    return {
      opacity: Number(computedStyle.find((p) => p.name === 'opacity')?.value),
      x: (x1! + x3!) / 2,
      y: (y1! + y3!) / 2,
    };
  } finally {
    await cdp.detach();
  }
}

const settle = () => new Promise((r) => setTimeout(r, 300));

describe('on-video snap button in real Chrome', () => {
  it('stays invisible while hovering the video and shows only on the button itself', async () => {
    const page = await ext.visit(fx.pageUrl());
    // a background tab renders no frames, and Chrome only updates :hover on a rendered frame
    await page.bringToFront();
    const box = (await page.locator('video').boundingBox())!;
    // middle of the video, well away from the button's corner
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await settle();
    const placed = await snapButton(page);
    expect(placed, 'button is placed over the hovered video').toBeTruthy();
    expect(placed!.opacity).toBe(0);

    await page.mouse.move(placed!.x, placed!.y);
    await settle();
    expect((await snapButton(page))!.opacity).toBe(1);

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await settle();
    expect((await snapButton(page))?.opacity ?? 0).toBe(0);
  });
});
