import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { collectFiles, createZip } from '../../scripts/zip';

/** Minimal independent reader: central directory to name, method, CRC and the inflated bytes. */
function readZip(zip: Uint8Array) {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.byteLength - 22;
  expect(v.getUint32(eocd, true)).toBe(0x06054b50);
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const out: Record<string, Uint8Array> = {};
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const method = v.getUint16(p + 10, true);
    const size = v.getUint32(p + 20, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    const dataAt = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    const raw = zip.subarray(dataAt, dataAt + size);
    out[name] = method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('createZip', () => {
  it('stores every entry under its path and round-trips the bytes', () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 251);
    const zip = createZip([
      { name: 'manifest.json', data: new TextEncoder().encode('{"a":1}') },
      { name: 'assets/big.bin', data: big },
      { name: 'empty.txt', data: new Uint8Array() },
    ]);
    const files = readZip(zip);
    expect(Object.keys(files).sort()).toEqual(['assets/big.bin', 'empty.txt', 'manifest.json']);
    expect(new TextDecoder().decode(files['manifest.json'])).toBe('{"a":1}');
    expect(files['assets/big.bin']).toEqual(big);
    expect(files['empty.txt']).toEqual(new Uint8Array());
  });
});

describe('collectFiles', () => {
  it('lists a folder recursively with forward-slash names, sorted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
    mkdirSync(join(dir, 'b'));
    writeFileSync(join(dir, 'z.txt'), 'z');
    writeFileSync(join(dir, 'b', 'a.txt'), 'a');
    const names = collectFiles(dir).map((f) => f.name);
    expect(names).toEqual(['b/a.txt', 'z.txt']);
    expect(readFileSync(join(dir, 'z.txt'), 'utf8')).toBe('z');
  });
});
