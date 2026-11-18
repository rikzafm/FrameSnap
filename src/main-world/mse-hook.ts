/**
 * MSE capture hook (MAIN world, document_start, sites the user granted).
 * Wraps MediaSource/SourceBuffer so every init + media segment a player
 * appends is also kept here, per SourceBuffer, up to a memory cap. A stream
 * can then be exported as the bytes the page buffered, in append order, which
 * is a fragmented MP4 (or WebM) that plays for that range.
 *
 * Nothing here talks to the extension: `mse-bridge` does, over a nonce-checked
 * postMessage channel.
 */

export const DEFAULT_MSE_MAX_BYTES = 256 * 1024 * 1024;

export type TrackKind = "video" | "audio" | "muxed";
export type MseContainer = "mp4" | "webm";

export interface TrackInfo {
  index: number;
  mime: string;
  kind: TrackKind;
  container: MseContainer;
  bytes: number;
}

export interface StreamInfo {
  id: string;
  /** The `blob:` URL a `<video>` plays this stream from, when the page used createObjectURL. */
  url?: string;
  tracks: TrackInfo[];
  /** Bytes held across all tracks. */
  bytes: number;
  /** Older media segments were dropped to stay under the cap. */
  truncated: boolean;
}

export interface ExportedStream {
  blob: Blob;
  mime: string;
  container: MseContainer;
  /** False when audio lives in a separate SourceBuffer that this file does not contain. */
  hasAudio: boolean;
}

export interface MseHookOptions {
  maxBytes?: number;
  onChange?(stream: StreamInfo): void;
}

export interface MseStore {
  streams(): StreamInfo[];
  export(id: string): ExportedStream | undefined;
}

/** The slice of `window` the hook patches. */
export interface MseWindow {
  MediaSource?: { prototype: { addSourceBuffer(mime: string): unknown } };
  SourceBuffer?: { prototype: { appendBuffer(data: BufferSource): void } };
  URL: { createObjectURL(o: unknown): string };
}

interface Segment {
  data: Uint8Array;
  init: boolean;
  /** Global append order across all tracks of the stream. */
  seq: number;
}

interface Track {
  info: Omit<TrackInfo, "bytes">;
  segments: Segment[];
  bytes: number;
}

interface Stream {
  id: string;
  url?: string;
  tracks: Track[];
  truncated: boolean;
  seq: number;
}

const VIDEO_CODEC = /^(avc[13]|hvc1|hev1|vp0?[89]|vp8|av01|theora|dvh[e1])/i;
const AUDIO_CODEC = /^(mp4a|opus|vorbis|ac-3|ec-3|flac|mp3)/i;

export function classifyMime(mime: string): { kind: TrackKind; container: MseContainer } {
  const m = mime.toLowerCase();
  const container: MseContainer = m.includes("webm") ? "webm" : "mp4";
  const codecs = /codecs\s*=\s*"?([^"]*)"?/.exec(m)?.[1]?.split(",").map((c) => c.trim()) ?? [];
  const hasVideo = codecs.some((c) => VIDEO_CODEC.test(c));
  const hasAudio = codecs.some((c) => AUDIO_CODEC.test(c));
  let kind: TrackKind;
  if (hasVideo && hasAudio) kind = "muxed";
  else if (hasAudio) kind = "audio";
  else if (hasVideo) kind = "video";
  else kind = m.startsWith("audio/") ? "audio" : "video";
  return { kind, container };
}

/** An initialization segment starts with `ftyp`/`moov` (ISO BMFF) or an EBML header (WebM). */
export function isInitSegment(d: Uint8Array): boolean {
  if (d.length >= 4 && d[0] === 0x1a && d[1] === 0x45 && d[2] === 0xdf && d[3] === 0xa3) return true;
  if (d.length < 8) return false;
  const type = String.fromCharCode(d[4]!, d[5]!, d[6]!, d[7]!);
  return type === "ftyp" || type === "moov";
}

const toBytes = (data: BufferSource): Uint8Array =>
  ArrayBuffer.isView(data) ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)) : new Uint8Array(data.slice(0));

export function installMseHook(win: MseWindow, opts: MseHookOptions = {}): MseStore {
  const maxBytes = opts.maxBytes ?? DEFAULT_MSE_MAX_BYTES;
  const streams = new Map<string, Stream>();
  const byMediaSource = new WeakMap<object, Stream>();
  const byBuffer = new WeakMap<object, { stream: Stream; track: Track }>();
  let counter = 0;

  const bytesOf = (s: Stream) => s.tracks.reduce((n, t) => n + t.bytes, 0);
  const infoOf = (s: Stream): StreamInfo => ({
    id: s.id,
    ...(s.url !== undefined ? { url: s.url } : {}),
    tracks: s.tracks.map((t) => ({ ...t.info, bytes: t.bytes })),
    bytes: bytesOf(s),
    truncated: s.truncated,
  });
  const changed = (s: Stream) => {
    try {
      opts.onChange?.(infoOf(s));
    } catch {
      /* a listener must never break the page's player */
    }
  };

  function evict(s: Stream) {
    while (bytesOf(s) > maxBytes) {
      // oldest droppable media segment across all tracks
      let from: Track | undefined;
      let at = -1;
      for (const t of s.tracks) {
        const i = t.segments.findIndex((x) => !x.init);
        if (i >= 0 && (!from || t.segments[i]!.seq < from.segments[at]!.seq)) (from = t), (at = i);
      }
      if (!from) return;
      const [gone] = from.segments.splice(at, 1);
      from.bytes -= gone!.data.length;
      s.truncated = true;
    }
  }

  const MS = win.MediaSource?.prototype;
  if (MS) {
    const addSourceBuffer = MS.addSourceBuffer;
    MS.addSourceBuffer = function (this: object, mime: string) {
      const sb = addSourceBuffer.call(this, mime) as object;
      try {
        let s = byMediaSource.get(this);
        if (!s) {
          s = { id: `ms${++counter}`, tracks: [], truncated: false, seq: 0 };
          byMediaSource.set(this, s);
          streams.set(s.id, s);
        }
        const track: Track = { info: { index: s.tracks.length, mime, ...classifyMime(mime) }, segments: [], bytes: 0 };
        s.tracks.push(track);
        byBuffer.set(sb, { stream: s, track });
        changed(s);
      } catch {
        /* keep the player working */
      }
      return sb;
    };
  }

  const SB = win.SourceBuffer?.prototype;
  if (SB) {
    const appendBuffer = SB.appendBuffer;
    SB.appendBuffer = function (this: object, data: BufferSource) {
      try {
        const rec = byBuffer.get(this);
        if (rec) {
          const bytes = toBytes(data);
          rec.track.segments.push({ data: bytes, init: isInitSegment(bytes), seq: rec.stream.seq++ });
          rec.track.bytes += bytes.length;
          evict(rec.stream);
          changed(rec.stream);
        }
      } catch {
        /* keep the player working */
      }
      return appendBuffer.call(this, data);
    };
  }

  const createObjectURL = win.URL.createObjectURL;
  win.URL.createObjectURL = function (this: unknown, obj: unknown) {
    const url = createObjectURL.call(this, obj);
    try {
      if (typeof obj === "object" && obj !== null) {
        let s = byMediaSource.get(obj);
        if (!s && win.MediaSource && obj instanceof (win.MediaSource as unknown as new () => object)) {
          s = { id: `ms${++counter}`, tracks: [], truncated: false, seq: 0 };
          byMediaSource.set(obj, s);
          streams.set(s.id, s);
        }
        if (s) s.url = url;
      }
    } catch {
      /* ignore */
    }
    return url;
  };

  return {
    streams: () => [...streams.values()].filter((s) => s.tracks.length > 0).map(infoOf),
    export(id) {
      const s = streams.get(id);
      if (!s || s.tracks.length === 0) return undefined;
      const track = s.tracks.find((t) => t.info.kind === "muxed") ?? s.tracks.find((t) => t.info.kind === "video") ?? s.tracks[0]!;
      const parts = track.segments.map((x) => x.data);
      const container = track.info.container;
      const mime = `${track.info.kind === "audio" ? "audio" : "video"}/${container === "webm" ? "webm" : "mp4"}`;
      return {
        blob: new Blob(parts as BlobPart[], { type: mime }),
        mime,
        container,
        hasAudio: track.info.kind !== "video",
      };
    },
  };
}
