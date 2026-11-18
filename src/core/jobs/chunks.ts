/**
 * Chunk planning. Every byte a job fetches belongs to exactly one chunk with a
 * key that stays the same across page refreshes (it never contains a URL),
 * so a resumed job can tell which chunks it already has.
 *
 *   progressive / DASH SegmentBase  r<start>-<end>   (8 MB byte ranges)
 *   no Range support                 whole
 *   HLS                              s<media sequence>, init
 *   DASH template / list             n<Number> | t<Time> | i<index>, init
 */
import type { Container } from "../model";
import { sequenceIv, type HlsSegment } from "../media/hls";
import type { DashRepresentation, DashSegment } from "../media/dash";

export const CHUNK_BYTES = 8 * 1024 * 1024;

export interface ChunkSpec {
  key: string;
  url: string;
  /** Inclusive byte range. */
  range?: { start: number; end: number };
  /** Known size, used to verify what arrives and to report progress. */
  bytes?: number;
  /** HLS AES-128: fetch the key and decrypt after download. */
  decrypt?: { keyUrl: string; ivHex: string };
}

export interface TrackPlan {
  /** Index in plan.inputs, as a string: "0", "1". */
  trackId: string;
  role: "video" | "audio" | "muxed";
  container: Container;
  chunks: ChunkSpec[];
  totalBytes?: number;
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Split one file into fixed-size byte ranges. */
export function planByteChunks(url: string, totalBytes: number, chunkBytes = CHUNK_BYTES): ChunkSpec[] {
  if (!(totalBytes > 0)) throw new Error("planByteChunks: totalBytes must be > 0");
  const out: ChunkSpec[] = [];
  for (let start = 0; start < totalBytes; start += chunkBytes) {
    const end = Math.min(totalBytes, start + chunkBytes) - 1;
    out.push({ key: `r${start}-${end}`, url, range: { start, end }, bytes: end - start + 1 });
  }
  return out;
}

/** One chunk for a server that does not support Range. */
export function wholeChunk(url: string, totalBytes?: number): ChunkSpec[] {
  return [{ key: "whole", url, bytes: totalBytes }];
}

function rangeOf(r: { offset: number; length: number } | undefined): ChunkSpec["range"] {
  return r ? { start: r.offset, end: r.offset + r.length - 1 } : undefined;
}

export function planHlsChunks(segments: readonly HlsSegment[]): ChunkSpec[] {
  const out: ChunkSpec[] = [];
  const map = segments.find((s) => s.map)?.map;
  if (map) {
    const range = rangeOf(map.byteRange);
    out.push({ key: "init", url: map.uri, range, bytes: range ? range.end - range.start + 1 : undefined });
  }
  for (const s of segments) {
    const range = rangeOf(s.byteRange);
    const spec: ChunkSpec = { key: `s${s.sequence}`, url: s.uri, range, bytes: range ? range.end - range.start + 1 : undefined };
    if (s.key?.method === "AES-128" && s.key.uri) {
      spec.decrypt = { keyUrl: s.key.uri, ivHex: bytesToHex(s.key.iv ?? sequenceIv(s.sequence)) };
    }
    out.push(spec);
  }
  return out;
}

/**
 * DASH representation → chunks for the kept segments. A "whole" segment
 * (SegmentBase) is split by byte range when the size is known and the
 * server takes ranges.
 */
export function planDashChunks(
  rep: Pick<DashRepresentation, "init">,
  segments: readonly DashSegment[],
  whole?: { totalBytes?: number; acceptsRanges: boolean },
): ChunkSpec[] {
  const out: ChunkSpec[] = [];
  if (rep.init) {
    const range = rangeOf(rep.init.byteRange);
    out.push({ key: "init", url: rep.init.url, range, bytes: range ? range.end - range.start + 1 : undefined });
  }
  for (const s of segments) {
    if (s.key === "whole") {
      if (whole?.acceptsRanges && whole.totalBytes) out.push(...planByteChunks(s.url, whole.totalBytes));
      else out.push(...wholeChunk(s.url, whole?.totalBytes));
      continue;
    }
    const range = rangeOf(s.byteRange);
    out.push({ key: s.key, url: s.url, range, bytes: range ? range.end - range.start + 1 : undefined });
  }
  return out;
}

export function missingChunks(track: TrackPlan, committed: ReadonlySet<string>): ChunkSpec[] {
  return track.chunks.filter((c) => !committed.has(c.key));
}

/** 0..1. By bytes when every chunk size is known, otherwise by chunk count. */
export function fetchProgress(tracks: readonly TrackPlan[], committed: ReadonlyMap<string, ReadonlySet<string>>): number {
  const all = tracks.flatMap((t) => t.chunks.map((c) => ({ c, done: committed.get(t.trackId)?.has(c.key) ?? false })));
  if (all.length === 0) return 1;
  if (all.every(({ c }) => c.bytes !== undefined)) {
    const total = all.reduce((s, { c }) => s + c.bytes!, 0);
    const done = all.reduce((s, { c, done }) => s + (done ? c.bytes! : 0), 0);
    return total ? done / total : 1;
  }
  return all.filter((x) => x.done).length / all.length;
}

/** FNV-1a 32-bit, hex. Used to fingerprint a track's chunk layout. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Same media, same chunking → same hash, whatever the (signed) URLs are. */
export function layoutHash(chunks: readonly ChunkSpec[]): string {
  return fnv1a(chunks.map((c) => `${c.key}:${c.range ? `${c.range.start}-${c.range.end}` : ""}:${c.bytes ?? ""}`).join("|"));
}
