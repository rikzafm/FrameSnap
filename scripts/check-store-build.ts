/**
 * Fails when the store build contains YouTube code or permissions.
 * Usage: tsx scripts/check-store-build.ts [dir=dist]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function findYoutubeLeaks(dir: string): string[] {
  const leaks: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/youtube|googlevideo/i.test(name)) leaks.push(`${p} (file name)`);
      else if (
        /\.(js|mjs|css|html|json|map)$/.test(name) &&
        /youtube|googlevideo/i.test(readFileSync(p, 'utf8'))
      )
        leaks.push(p);
    }
  };
  walk(dir);
  return leaks;
}

if (process.argv[1] && /check-store-build/.test(process.argv[1])) {
  const dir = process.argv[2] ?? 'dist';
  const leaks = findYoutubeLeaks(dir);
  if (leaks.length) {
    console.error(`YouTube strings found in ${dir}:\n${leaks.join('\n')}`);
    process.exit(1);
  }
  console.log(`${dir}: no YouTube code or permissions`);
}
