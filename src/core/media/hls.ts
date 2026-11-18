/**
 * HLS playlist parser (RFC 8216 subset Frame Snap needs).
 * Master: variants + alternate audio. Media: segments, byte ranges, keys, init map.
 */

export interface HlsVariant {
  uri: string;
  bandwidth: number;
  width?: number;
  height?: number;
  codecs?: string;
  audioGroup?: string;
  frameRate?: number;
}

export interface HlsRendition {
  type: "AUDIO" | "SUBTITLES" | "VIDEO" | "CLOSED-CAPTIONS";
  groupId: string;
  name: string;
  uri?: string;
  language?: string;
  isDefault: boolean;
}

export interface HlsMaster {
  variants: HlsVariant[];
  renditions: HlsRendition[];
}

export interface HlsKey {
  method: "NONE" | "AES-128" | "SAMPLE-AES" | "SAMPLE-AES-CTR" | string;
  uri?: string;
  /** 16 bytes. Absent → derived from the media sequence number. */
  iv?: Uint8Array;
  keyFormat: string;
}

export interface ByteRange {
  /** Inclusive start offset. */
  offset: number;
  length: number;
}

export interface HlsSegment {
  uri: string;
  /** Media sequence number: the stable key used for resume. */
  sequence: number;
  duration: number;
  /** Seconds from playlist start. */
  start: number;
  byteRange?: ByteRange;
  key?: HlsKey;
  map?: { uri: string; byteRange?: ByteRange };
}

export interface HlsMedia {
  targetDuration: number;
  mediaSequence: number;
  /** No #EXT-X-ENDLIST → live window. */
  live: boolean;
  segments: HlsSegment[];
  totalDuration: number;
  /** Any segment uses a key system other than plain AES-128 / identity. */
  protection: "none" | "drm";
  /** Init section present → fMP4 segments, else MPEG-TS. */
  container: "fmp4" | "ts";
}

export function isMasterPlaylist(text: string): boolean {
  return /#EXT-X-STREAM-INF/.test(text);
}

/** Parse an attribute list: KEY=value,KEY="quoted, value",... */
export function parseAttributes(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const raw = m[2]!;
    out[m[1]!] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  }
  return out;
}

function lines(text: string): string[] {
  const all = text.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (all[0] !== "#EXTM3U") throw new Error("HLS: missing #EXTM3U");
  return all;
}

function resolve(uri: string, base: string): string {
  return new URL(uri, base).toString();
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/i, "").padStart(32, "0");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Default AES-128 IV: the media sequence number as a 128-bit big-endian integer. */
export function sequenceIv(sequence: number): Uint8Array {
  const iv = new Uint8Array(16);
  let n = sequence;
  for (let i = 15; i >= 0 && n > 0; i--) {
    iv[i] = n % 256;
    n = Math.floor(n / 256);
  }
  return iv;
}

function parseByteRange(value: string, nextOffset: number): ByteRange {
  const [len, off] = value.split("@");
  return { length: Number(len), offset: off === undefined ? nextOffset : Number(off) };
}

export function parseMaster(text: string, baseUrl: string): HlsMaster {
  const ls = lines(text);
  const variants: HlsVariant[] = [];
  const renditions: HlsRendition[] = [];
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i]!;
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const a = parseAttributes(line.slice(18));
      const uri = ls[i + 1];
      if (!uri || uri.startsWith("#")) continue;
      const [w, h] = (a.RESOLUTION ?? "").split("x").map(Number);
      variants.push({
        uri: resolve(uri, baseUrl),
        bandwidth: Number(a["AVERAGE-BANDWIDTH"] ?? a.BANDWIDTH ?? 0),
        width: w || undefined,
        height: h || undefined,
        codecs: a.CODECS,
        audioGroup: a.AUDIO,
        frameRate: a["FRAME-RATE"] ? Number(a["FRAME-RATE"]) : undefined,
      });
      i++;
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = parseAttributes(line.slice(13));
      renditions.push({
        type: (a.TYPE ?? "AUDIO") as HlsRendition["type"],
        groupId: a["GROUP-ID"] ?? "",
        name: a.NAME ?? "",
        uri: a.URI ? resolve(a.URI, baseUrl) : undefined,
        language: a.LANGUAGE,
        isDefault: a.DEFAULT === "YES",
      });
    }
  }
  variants.sort((x, y) => (y.height ?? 0) - (x.height ?? 0) || y.bandwidth - x.bandwidth);
  return { variants, renditions };
}

export function parseMedia(text: string, baseUrl: string): HlsMedia {
  const ls = lines(text);
  let targetDuration = 0;
  let mediaSequence = 0;
  let live = true;
  let protection: HlsMedia["protection"] = "none";
  const segments: HlsSegment[] = [];

  let key: HlsKey | undefined;
  let map: HlsSegment["map"];
  let pendingDuration: number | undefined;
  let pendingRange: ByteRange | undefined;
  let nextOffset = 0;
  let start = 0;

  for (const line of ls) {
    if (line.startsWith("#EXT-X-TARGETDURATION:")) targetDuration = Number(line.slice(22));
    else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) mediaSequence = Number(line.slice(22));
    else if (line === "#EXT-X-ENDLIST") live = false;
    else if (line.startsWith("#EXT-X-PLAYLIST-TYPE:VOD")) live = false;
    else if (line.startsWith("#EXTINF:")) pendingDuration = parseFloat(line.slice(8));
    else if (line.startsWith("#EXT-X-BYTERANGE:")) pendingRange = parseByteRange(line.slice(17), nextOffset);
    else if (line.startsWith("#EXT-X-KEY:")) {
      const a = parseAttributes(line.slice(11));
      const method = a.METHOD ?? "NONE";
      const keyFormat = a.KEYFORMAT ?? "identity";
      if (method === "NONE") key = undefined;
      else {
        key = { method, uri: a.URI ? resolve(a.URI, baseUrl) : undefined, iv: a.IV ? hexToBytes(a.IV) : undefined, keyFormat };
        if (method !== "AES-128" || keyFormat !== "identity") protection = "drm";
      }
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const a = parseAttributes(line.slice(11));
      map = { uri: resolve(a.URI ?? "", baseUrl), byteRange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : undefined };
    } else if (!line.startsWith("#")) {
      const duration = pendingDuration ?? targetDuration;
      const seg: HlsSegment = { uri: resolve(line, baseUrl), sequence: mediaSequence + segments.length, duration, start };
      if (pendingRange) {
        seg.byteRange = pendingRange;
        nextOffset = pendingRange.offset + pendingRange.length;
      }
      if (key) seg.key = key;
      if (map) seg.map = map;
      segments.push(seg);
      start += duration;
      pendingDuration = undefined;
      pendingRange = undefined;
    }
  }
  return {
    targetDuration,
    mediaSequence,
    live,
    segments,
    totalDuration: start,
    protection,
    container: segments.some((s) => s.map) ? "fmp4" : "ts",
  };
}

/** Highest-bandwidth audio rendition URI for a variant's AUDIO group, if any. */
export function audioRenditionFor(master: HlsMaster, variant: HlsVariant): HlsRendition | undefined {
  if (!variant.audioGroup) return undefined;
  const group = master.renditions.filter((r) => r.type === "AUDIO" && r.groupId === variant.audioGroup && r.uri);
  return group.find((r) => r.isDefault) ?? group[0];
}
