/**
 * Chrome Web Store images built from the logo: the 128 px icon, the two promo tiles and a
 * 1280x800 screenshot of the popup (taken from the real build in Chrome).
 * Usage: tsx scripts/store-assets.ts   (needs `npm run build` and an installed Chrome)
 * Output: release/store-assets/
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

export const STORE_IMAGES = [
  { file: 'promo-small-440x280.png', width: 440, height: 280 },
  { file: 'promo-marquee-1400x560.png', width: 1400, height: 560 },
] as const;

const PAPER = '#FAF8F3';
const ACCENT = '#C23A08';

interface Shot {
  base64: string;
  width: number;
  height: number;
}

/** The logo mark centred on a paper background, optionally beside a popup screenshot. */
export function storeImageSvg(o: { width: number; height: number; shot?: Shot }): string {
  const { width, height, shot } = o;
  const mark = Math.round(Math.min(width, height) * (shot ? 0.34 : 0.5));
  const markX = shot ? Math.round(width * 0.24 - mark / 2) : Math.round((width - mark) / 2);
  const markY = Math.round((height - mark) / 2);
  const scale = mark / 128;
  let shotSvg = '';
  if (shot) {
    const h = Math.round(height * 0.86);
    const w = Math.round((shot.width / shot.height) * h);
    const x = Math.round(width * 0.66 - w / 2);
    const y = Math.round((height - h) / 2);
    shotSvg =
      `<rect x="${x - 2}" y="${y - 2}" width="${w + 4}" height="${h + 4}" rx="14" fill="#1D1B17" opacity="0.12"/>` +
      `<image x="${x}" y="${y}" width="${w}" height="${h}" href="data:image/png;base64,${shot.base64}"/>`;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="${width}" height="${height}" fill="${PAPER}"/>` +
    `<g transform="translate(${markX} ${markY}) scale(${scale})">` +
    `<rect width="128" height="128" rx="32" fill="${ACCENT}"/>` +
    `<g fill="none" stroke="${PAPER}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="M22 50V30a8 8 0 0 1 8-8h20"/><path d="M78 22h20a8 8 0 0 1 8 8v20"/>` +
    `<path d="M106 78v20a8 8 0 0 1-8 8H78"/><path d="M50 106H30a8 8 0 0 1-8-8V78"/></g>` +
    `<circle cx="64" cy="64" r="11" fill="${PAPER}"/></g>${shotSvg}</svg>`
  );
}

const render = (svg: string) => new Resvg(svg).render().asPng();

if (process.argv[1] && /[\\/]store-assets\.ts$/.test(process.argv[1])) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const out = join(root, 'release', 'store-assets');
  mkdirSync(out, { recursive: true });
  copyFileSync(join(root, 'public/icons/icon-128.png'), join(out, 'icon-128.png'));
  for (const i of STORE_IMAGES) writeFileSync(join(out, i.file), render(storeImageSvg(i)));

  // a screenshot of the real popup with the fixture video listed
  const dist = join(root, 'dist');
  if (existsSync(join(dist, 'manifest.json'))) {
    const { createFixtureServer } = await import('../tests/e2e/fixture-server');
    const { makeClip, padMp4 } = await import('../tests/e2e/clip');
    const { launchExtension } = await import('../tests/e2e/harness');
    const fx = await createFixtureServer({ body: padMp4(await makeClip(), 4 * 1024 * 1024) });
    const ext = await launchExtension({ dist });
    try {
      const page = await ext.visit(fx.pageUrl());
      const popup = await ext.openPopup(page);
      await popup.setViewportSize({ width: 380, height: 640 });
      await popup.getByRole('button', { name: 'Download', exact: true }).first().waitFor();
      const png = await popup.screenshot({ type: 'png' });
      const shot = { base64: png.toString('base64'), width: 380, height: 640 };
      writeFileSync(
        join(out, 'screenshot-popup-1280x800.png'),
        render(storeImageSvg({ width: 1280, height: 800, shot })),
      );
    } finally {
      await ext.close();
      await fx.stop();
    }
  }
  console.log(`store assets in ${out}`);
}
