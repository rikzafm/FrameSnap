/**
 * Zips a build folder for the Chrome Web Store or for sharing. No dependencies: a small ZIP
 * writer over node:zlib.
 * Usage: tsx scripts/zip.ts [dir=dist] [out=release/frame-snap-<version>.zip]
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** Every file under `dir`, with forward-slash names relative to it, in a stable order. */
export function collectFiles(dir: string): ZipEntry[] {
  const out: ZipEntry[] = [];
  const walk = (d: string, prefix: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}${name}/`);
      else out.push({ name: `${prefix}${name}`, data: new Uint8Array(readFileSync(p)) });
    }
  };
  walk(dir, '');
  return out;
}

export function createZip(entries: ZipEntry[]): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  // fixed timestamp 2000-01-01 so the same build always gives the same zip
  const time = 0;
  const date = (20 << 9) | (1 << 5) | 1;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.from(e.data);
    const deflated = deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, body);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(useDeflate ? 8 : 0, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += local.length + name.length + body.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, centralBytes, end]));
}

if (process.argv[1] && /[\\/]zip\.ts$/.test(process.argv[1])) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const dir = resolve(process.argv[2] ?? 'dist');
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
    version: string;
  };
  const out = resolve(
    process.argv[3] ?? join(root, 'release', `frame-snap-${manifest.version}.zip`),
  );
  mkdirSync(dirname(out), { recursive: true });
  const files = collectFiles(dir);
  writeFileSync(out, createZip(files));
  console.log(`${out} (${files.length} files)`);
}
