import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'public/icons');
mkdirSync(out, { recursive: true });

// The hinted 16 px master is used for the smallest size; the rest scale the main mark.
const jobs: Array<[number, string]> = [
  [16, 'frame-snap-16.svg'],
  [32, 'frame-snap.svg'],
  [48, 'frame-snap.svg'],
  [128, 'frame-snap.svg'],
];

for (const [size, file] of jobs) {
  const svg = readFileSync(resolve(root, 'assets/logo', file));
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(resolve(out, `icon-${size}.png`), png);
  console.log(`icon-${size}.png`);
}
