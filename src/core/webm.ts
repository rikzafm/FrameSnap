/**
 * Finalize a live-written WebM (MediaRecorder output) so players can show its length and seek.
 *
 * MediaRecorder writes the file as it goes: the Segment and every Cluster have "unknown" sizes,
 * Info has no Duration and there is no Cues index. This rewrites the container around the
 * untouched cluster payloads:
 *
 *   EBML header | Segment(known size) { SeekHead, Info(+Duration), Tracks, other, Clusters(known sizes), Cues }
 *
 * The frames are never copied: the output names byte ranges of the input for the cluster bodies.
 * Anything this does not understand leaves the file as it was.
 */

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  DefaultDuration: 0x23e383,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  ReferenceBlock: 0xfb,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Void: 0xec,
  CRC32: 0xbf,
} as const;

/** Children a Cluster may hold; any other ID ends an unknown-size cluster. */
const CLUSTER_CHILDREN = new Set<number>([ID.Timecode, 0x5854, 0xa7, 0xab, ID.SimpleBlock, ID.BlockGroup, 0xaf, ID.Void, ID.CRC32]);

/** A byte range of the input, or bytes written here. */
export type WebmPart = Uint8Array<ArrayBuffer> | { from: number; to: number };

export interface FinalizedWebm {
  parts: WebmPart[];
  /** Length written into Info, in seconds. */
  durationSec: number;
  cues: number;
}

interface Header {
  id: number;
  start: number;
  dataStart: number;
  /** Undefined for an unknown size. */
  size: number | undefined;
}

function readHeader(b: Uint8Array, pos: number): Header | undefined {
  const first = b[pos];
  if (first === undefined || first === 0) return undefined;
  const idLen = Math.clz32(first) - 23; // 1..4 for a valid ID
  if (idLen < 1 || idLen > 4 || pos + idLen > b.length) return undefined;
  let id = 0;
  for (let i = 0; i < idLen; i++) id = id * 256 + b[pos + i]!;
  const p = pos + idLen;
  const s0 = b[p];
  if (s0 === undefined || s0 === 0) return undefined;
  const sizeLen = Math.clz32(s0) - 23;
  if (p + sizeLen > b.length) return undefined;
  let size = s0 & (0xff >> sizeLen);
  let allOnes = size === 0xff >> sizeLen;
  for (let i = 1; i < sizeLen; i++) {
    const v = b[p + i]!;
    size = size * 256 + v;
    if (v !== 0xff) allOnes = false;
  }
  return { id, start: pos, dataStart: p + sizeLen, size: allOnes ? undefined : size };
}

function readUint(b: Uint8Array, from: number, to: number): number {
  let v = 0;
  for (let i = from; i < to; i++) v = v * 256 + b[i]!;
  return v;
}

function readFloat(b: Uint8Array, from: number, to: number): number {
  const dv = new DataView(b.buffer, b.byteOffset + from, to - from);
  return to - from === 4 ? dv.getFloat32(0) : to - from === 8 ? dv.getFloat64(0) : NaN;
}

/** Known-size children of [from, to); stops at the first one that does not fit. */
function children(b: Uint8Array, from: number, to: number): Header[] {
  const out: Header[] = [];
  let pos = from;
  while (pos < to) {
    const h = readHeader(b, pos);
    if (!h || h.size === undefined || h.dataStart + h.size > to) break;
    out.push(h);
    pos = h.dataStart + h.size;
  }
  return out;
}

// ---- writing --------------------------------------------------------------------

function idBytes(id: number): number[] {
  const out: number[] = [];
  for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  return out;
}

/** EBML size, minimal width unless `width` is given. */
function sizeBytes(n: number, width?: number): number[] {
  let w = width ?? 1;
  while (n >= 2 ** (7 * w) - 1) w++;
  const out: number[] = new Array<number>(w);
  let v = n;
  for (let i = w - 1; i >= 0; i--) {
    out[i] = v % 256;
    v = Math.floor(v / 256);
  }
  out[0]! |= 0x80 >> (w - 1);
  return out;
}

function uintBytes(n: number, width?: number): number[] {
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
  while (out.length < (width ?? 1)) out.unshift(0);
  return out;
}

function concat(parts: (Uint8Array | number[])[]): Uint8Array<ArrayBuffer> {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function el(id: number, payload: Uint8Array | number[]): Uint8Array<ArrayBuffer> {
  return concat([idBytes(id), sizeBytes(payload.length), payload]);
}

function floatEl(id: number, v: number): Uint8Array<ArrayBuffer> {
  const f = new Uint8Array(8);
  new DataView(f.buffer).setFloat64(0, v);
  return el(id, f);
}

// ---- parsing --------------------------------------------------------------------

interface Track {
  number: number;
  type: number;
  /** Frame length in TimecodeScale ticks, from DefaultDuration. */
  frame?: number;
}

interface Cluster {
  start: number;
  bodyStart: number;
  bodyEnd: number;
  /** First keyframe per track, as absolute ticks. */
  keyframes: Map<number, number>;
}

/** Plan the finalized file, or undefined when the input is not a WebM this understands. */
export function finalizeWebmBytes(b: Uint8Array<ArrayBuffer>): FinalizedWebm | undefined {
  const ebml = readHeader(b, 0);
  if (!ebml || ebml.id !== ID.EBML || ebml.size === undefined) return undefined;
  const headerEnd = ebml.dataStart + ebml.size;
  const seg = readHeader(b, headerEnd);
  if (!seg || seg.id !== ID.Segment) return undefined;
  const segEnd = seg.size === undefined ? b.length : Math.min(b.length, seg.dataStart + seg.size);

  let info: Header | undefined;
  let tracksEl: Header | undefined;
  const other: Header[] = [];
  const clusters: Cluster[] = [];
  const tracks = new Map<number, Track>();
  let scale = 1_000_000;
  /** Per track: latest block time and the smallest gap between its blocks (one frame). */
  const last = new Map<number, { t: number; gap?: number }>();
  let end = 0;

  let pos = seg.dataStart;
  while (pos < segEnd) {
    const h = readHeader(b, pos);
    if (!h) break;
    if (h.id === ID.Cluster) {
      const limit = h.size === undefined ? segEnd : Math.min(segEnd, h.dataStart + h.size);
      let at = h.dataStart;
      let tc: number | undefined;
      const keyframes = new Map<number, number>();
      while (at < limit) {
        const c = readHeader(b, at);
        if (!c || !CLUSTER_CHILDREN.has(c.id) || c.size === undefined || c.dataStart + c.size > limit) break;
        const cEnd = c.dataStart + c.size;
        if (c.id === ID.Timecode) tc = readUint(b, c.dataStart, cEnd);
        else if (c.id === ID.SimpleBlock || c.id === ID.BlockGroup) {
          if (tc === undefined) return undefined;
          let block = c;
          let key: boolean;
          let dur: number | undefined;
          if (c.id === ID.SimpleBlock) key = (b[blockFlagsAt(b, c.dataStart)] ?? 0) >= 0x80;
          else {
            const kids = children(b, c.dataStart, cEnd);
            const inner = kids.find((k) => k.id === ID.Block);
            if (!inner) return undefined;
            block = inner;
            key = !kids.some((k) => k.id === ID.ReferenceBlock);
            const bd = kids.find((k) => k.id === ID.BlockDuration);
            if (bd) dur = readUint(b, bd.dataStart, bd.dataStart + bd.size!);
          }
          const t = blockTime(b, block.dataStart, tc);
          if (!t) return undefined;
          const prev = last.get(t.track);
          const gap = prev && t.at > prev.t ? Math.min(t.at - prev.t, prev.gap ?? Infinity) : prev?.gap;
          last.set(t.track, { t: Math.max(t.at, prev?.t ?? -Infinity), ...(gap !== undefined ? { gap } : {}) });
          if (dur !== undefined) end = Math.max(end, t.at + dur);
          if (key && !keyframes.has(t.track)) keyframes.set(t.track, t.at);
        }
        at = cEnd;
      }
      if (tc === undefined) {
        if (at === h.dataStart) break; // truncated before anything usable
        return undefined;
      }
      clusters.push({ start: h.start, bodyStart: h.dataStart, bodyEnd: at, keyframes });
      if (at < limit && h.size !== undefined) break; // a known-size cluster cut short: the file ends here
      pos = h.size === undefined ? at : limit;
      continue;
    }
    if (h.size === undefined) return undefined;
    const hEnd = h.dataStart + h.size;
    if (hEnd > segEnd) break; // truncated tail
    if (h.id === ID.Info) info = h;
    else if (h.id === ID.Tracks) tracksEl = h;
    else if (h.id === ID.EBML || h.id === ID.Segment) break;
    else if (h.id !== ID.SeekHead && h.id !== ID.Cues && h.id !== ID.Void) other.push(h);
    pos = hEnd;
  }
  if (!info || !tracksEl || clusters.length === 0) return undefined;

  const infoKids = children(b, info.dataStart, info.dataStart + info.size!);
  const ts = infoKids.find((k) => k.id === ID.TimecodeScale);
  if (ts) scale = readUint(b, ts.dataStart, ts.dataStart + ts.size!) || scale;
  for (const entry of children(b, tracksEl.dataStart, tracksEl.dataStart + tracksEl.size!)) {
    if (entry.id !== ID.TrackEntry) continue;
    const kids = children(b, entry.dataStart, entry.dataStart + entry.size!);
    const get = (id: number) => {
      const k = kids.find((x) => x.id === id);
      return k ? readUint(b, k.dataStart, k.dataStart + k.size!) : undefined;
    };
    const number = get(ID.TrackNumber);
    if (number === undefined) continue;
    const dd = get(ID.DefaultDuration);
    tracks.set(number, { number, type: get(ID.TrackType) ?? 0, ...(dd ? { frame: dd / scale } : {}) });
  }
  if (tracks.size === 0) return undefined;

  // the last frame lasts as long as its track's frames do (DefaultDuration, else the smallest gap)
  for (const [track, l] of last) {
    const frame = tracks.get(track)?.frame ?? (l.gap ?? 0);
    end = Math.max(end, l.t + Math.max(0, frame));
  }
  if (!(end > 0)) return undefined;

  // ---- write
  const infoBody = concat([
    ...infoKids.filter((k) => k.id !== ID.Duration && k.id !== ID.Void && k.id !== ID.CRC32).map((k) => b.subarray(k.start, k.dataStart + k.size!)),
    ...(ts ? [] : [el(ID.TimecodeScale, uintBytes(scale))]),
    floatEl(ID.Duration, end),
  ]);
  const infoOut = el(ID.Info, infoBody);
  const tracksOut = b.subarray(tracksEl.start, tracksEl.dataStart + tracksEl.size!);
  const otherOut = other.map((h) => b.subarray(h.start, h.dataStart + h.size!));

  // fixed-width SeekPositions keep the SeekHead's size independent of where things land
  const seekHead = (positions: number[]) =>
    el(
      ID.SeekHead,
      concat(
        [ID.Info, ID.Tracks, ID.Cues].map((id, i) => el(ID.Seek, concat([el(ID.SeekID, idBytes(id)), el(ID.SeekPosition, uintBytes(positions[i]!, 8))]))),
      ),
    );
  const seekLen = seekHead([0, 0, 0]).length;
  const infoPos = seekLen;
  const tracksPos = infoPos + infoOut.length;
  let at = tracksPos + tracksOut.length + otherOut.reduce((s, o) => s + o.length, 0);

  const cueTrack =
    [...tracks.values()].find((t) => t.type === 1)?.number ??
    [...tracks.values()].find((t) => clusters.some((c) => c.keyframes.has(t.number)))?.number ??
    [...tracks.keys()][0]!;
  const clusterParts: WebmPart[] = [];
  const cuePoints: Uint8Array<ArrayBuffer>[] = [];
  for (const c of clusters) {
    const bodyLen = c.bodyEnd - c.bodyStart;
    const header = concat([idBytes(ID.Cluster), sizeBytes(bodyLen, 8)]);
    const key = c.keyframes.get(cueTrack);
    if (key !== undefined) {
      cuePoints.push(
        el(
          ID.CuePoint,
          concat([el(ID.CueTime, uintBytes(key)), el(ID.CueTrackPositions, concat([el(ID.CueTrack, uintBytes(cueTrack)), el(ID.CueClusterPosition, uintBytes(at))]))]),
        ),
      );
    }
    clusterParts.push(header, { from: c.bodyStart, to: c.bodyEnd });
    at += header.length + bodyLen;
  }
  const cuesPos = at;
  const cuesOut = el(ID.Cues, concat(cuePoints));
  const segBodyLen = cuesPos + cuesOut.length;

  const parts: WebmPart[] = [
    { from: 0, to: headerEnd },
    concat([idBytes(ID.Segment), sizeBytes(segBodyLen, 8)]),
    seekHead([infoPos, tracksPos, cuesPos]),
    infoOut,
    tracksOut,
    ...otherOut,
    ...clusterParts,
    cuesOut,
  ];
  return { parts, durationSec: (end * scale) / 1e9, cues: cuePoints.length };
}

/** Offset of a block's flags byte: after the track-number VINT and the 16-bit timecode. */
function blockFlagsAt(b: Uint8Array, dataStart: number): number {
  const len = Math.clz32(b[dataStart] ?? 0) - 23;
  return dataStart + len + 2;
}

function blockTime(b: Uint8Array, dataStart: number, clusterTc: number): { track: number; at: number } | undefined {
  const t0 = b[dataStart];
  if (!t0) return undefined;
  const len = Math.clz32(t0) - 23;
  if (len < 1 || len > 8 || dataStart + len + 2 > b.length) return undefined;
  let track = t0 & (0xff >> len);
  for (let i = 1; i < len; i++) track = track * 256 + b[dataStart + i]!;
  const rel = new DataView(b.buffer, b.byteOffset + dataStart + len, 2).getInt16(0);
  return { track, at: clusterTc + rel };
}

/** Duration in seconds already written in the file's Info, if any. Used by tests and checks. */
export function webmDurationSec(b: Uint8Array): number | undefined {
  const ebml = readHeader(b, 0);
  if (!ebml || ebml.size === undefined) return undefined;
  const seg = readHeader(b, ebml.dataStart + ebml.size);
  if (!seg || seg.id !== ID.Segment) return undefined;
  const segEnd = seg.size === undefined ? b.length : Math.min(b.length, seg.dataStart + seg.size);
  for (const h of children(b, seg.dataStart, segEnd)) {
    if (h.id !== ID.Info) continue;
    const kids = children(b, h.dataStart, h.dataStart + h.size!);
    const d = kids.find((k) => k.id === ID.Duration);
    const s = kids.find((k) => k.id === ID.TimecodeScale);
    if (!d) return undefined;
    const scale = s ? readUint(b, s.dataStart, s.dataStart + s.size!) : 1_000_000;
    return (readFloat(b, d.dataStart, d.dataStart + d.size!) * scale) / 1e9;
  }
  return undefined;
}

/** Finalized copy of a recorded WebM blob; the blob itself when it cannot be finalized. */
export async function finalizeWebm(blob: Blob): Promise<Blob> {
  let plan: FinalizedWebm | undefined;
  try {
    plan = finalizeWebmBytes(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    plan = undefined;
  }
  if (!plan) return blob;
  return new Blob(
    plan.parts.map((p) => (p instanceof Uint8Array ? p : blob.slice(p.from, p.to))),
    { type: blob.type },
  );
}
