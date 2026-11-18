/**
 * YouTube adapter (personal build only, compiled in when `__YOUTUBE__`).
 * The main-world reader forwards `ytInitialPlayerResponse`; this adapter turns
 * `streamingData` into variants. Video-only adaptive formats are variants with
 * `hasAudio: false`, audio-only formats are `audioTracks`, muxed by the
 * download pipeline. Formats that only carry a `signatureCipher` are skipped.
 */
import type { AudioTrack, Container, Variant, VideoSource } from '../core/model';
import type { DetectContext, SiteAdapter } from './types';
import { splitCodecString } from './codec-strings';

/** Tag of the payload the main-world reader posts. */
export const YT_TAP_KIND = 'youtube-player';

const HOST_RE = /^(?:[a-z0-9-]+\.)*youtube\.com$/i;

function matches(pageUrl: string): boolean {
  try {
    const u = new URL(pageUrl);
    return /^https?:$/.test(u.protocol) && HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === 'string' && x ? x : undefined);
const num = (x: unknown): number | undefined => {
  const n = typeof x === 'string' ? Number(x) : x;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;
};

function containerOf(mime: string): Container {
  if (/\/webm/i.test(mime)) return 'webm';
  if (/\/mp4/i.test(mime)) return 'mp4';
  return 'unknown';
}

function buildVariant(f: Json, muxed: boolean): Variant | undefined {
  const url = str(f.url);
  const mime = str(f.mimeType) ?? '';
  const itag = f.itag;
  if (!url || typeof itag !== 'number' || !mime.startsWith('video/')) return undefined;
  const codecs = /codecs="([^"]*)"/.exec(mime)?.[1];
  const { video, audio } = splitCodecString(codecs);
  const width = num(f.width);
  const height = num(f.height);
  const bitrate = num(f.bitrate);
  const size = num(f.contentLength);
  return {
    id: `itag:${itag}`,
    kind: 'progressive',
    url,
    container: containerOf(mime),
    ...(video ? { videoCodec: video } : {}),
    ...(muxed && audio ? { audioCodec: audio } : {}),
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(bitrate ? { bitrate } : {}),
    ...(size ? { sizeBytes: size } : {}),
    acceptsRanges: true,
    hasAudio: muxed,
  };
}

function buildAudio(f: Json): AudioTrack | undefined {
  const url = str(f.url);
  const mime = str(f.mimeType) ?? '';
  const itag = f.itag;
  if (!url || typeof itag !== 'number' || !mime.startsWith('audio/')) return undefined;
  const codec = splitCodecString(/codecs="([^"]*)"/.exec(mime)?.[1]).audio;
  const bitrate = num(f.bitrate);
  const size = num(f.contentLength);
  const trackId = isObj(f.audioTrack) ? str(f.audioTrack.id) : undefined;
  const language = trackId?.split('.')[0];
  return {
    id: `itag:${itag}`,
    kind: 'progressive',
    url,
    ...(codec ? { codec } : {}),
    ...(bitrate ? { bitrate } : {}),
    ...(language ? { language } : {}),
    ...(size ? { sizeBytes: size } : {}),
  };
}

function fromResponse(r: unknown, ctx: DetectContext): VideoSource | undefined {
  if (!isObj(r) || !isObj(r.videoDetails) || !isObj(r.streamingData)) return undefined;
  if (isObj(r.playabilityStatus) && r.playabilityStatus.status !== 'OK') return undefined;
  const d = r.videoDetails;
  const videoId = str(d.videoId);
  if (!videoId || d.isLive === true) return undefined;
  const sd = r.streamingData;
  const muxed = (Array.isArray(sd.formats) ? sd.formats : []).filter(isObj);
  const adaptive = (Array.isArray(sd.adaptiveFormats) ? sd.adaptiveFormats : []).filter(isObj);
  const variants = [
    ...muxed.map((f) => buildVariant(f, true)),
    ...adaptive.map((f) => buildVariant(f, false)),
  ].filter((v): v is Variant => !!v);
  const audioTracks = adaptive.map(buildAudio).filter((a): a is AudioTrack => !!a);
  if (!variants.length) return undefined;
  const duration = num(d.lengthSeconds);
  return {
    id: `youtube:${videoId}`,
    site: 'youtube',
    title: str(d.title) ?? ctx.pageTitle,
    pageUrl: ctx.pageUrl,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    ...(duration ? { duration } : {}),
    variants,
    audioTracks,
    protection: 'none',
    detectedBy: ['adapter'],
  };
}

function detect(ctx: DetectContext): VideoSource[] {
  const out = new Map<string, VideoSource>();
  // Later payloads (SPA navigations, refreshed player responses) win.
  for (const p of ctx.tapped ?? []) {
    if (!isObj(p) || p.kind !== YT_TAP_KIND) continue;
    const src = fromResponse(p.response, ctx);
    if (src) out.set(src.id, src);
  }
  return [...out.values()];
}

export const youtubeAdapter: SiteAdapter = { site: 'youtube', matches, detect };
