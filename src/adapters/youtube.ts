/**
 * YouTube adapter.
 * The main-world reader forwards `ytInitialPlayerResponse`; this adapter turns
 * `streamingData` into variants. Video-only adaptive formats are variants with
 * `hasAudio: false`, audio-only formats are `audioTracks`, muxed by the
 * download pipeline. Formats that only carry a `signatureCipher` are skipped
 * unless a cipher manifest (TV lookup) is at hand.
 *
 * The page's WEB response is usually SABR-only, so it may yield no variants
 * at all. The source is still reported, and `resolve` asks the player API as
 * VISIONOS client, then ANDROID, then TV with the signature cipher (see
 * youtube-innertube.ts, youtube-cipher.ts), for downloadable URLs.
 * Those variants carry the client's prefix (`vos:`, `and:`) so the lookup
 * runs once per source.
 */
import type { AudioTrack, Container, Variant, VideoSource } from '../core/model';
import type { AdapterContext, DetectContext, SiteAdapter } from './types';
import { splitCodecString } from './codec-strings';
import {
  IFRAME_API_URL,
  baseJsUrl,
  formatUrl,
  parseCipherManifest,
  parsePlayerVersion,
  type CipherManifest,
} from './youtube-cipher';
import {
  PLAYER_CLIENTS,
  PLAYER_ENDPOINT,
  VISITOR_DATA_URL,
  parseVisitorData,
} from './youtube-innertube';

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

/** googlevideo caps one request to about playback speed unless the URL says `ratebypass=yes`. */
function isThrottled(url: string): boolean {
  try {
    return new URL(url).searchParams.get('ratebypass') !== 'yes';
  } catch {
    return true;
  }
}

function buildVariant(f: Json, muxed: boolean, prefix: string, cipher?: CipherManifest): Variant | undefined {
  const url = formatUrl(f, cipher);
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
    id: `${prefix}itag:${itag}`,
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
    ...(isThrottled(url) ? { throttled: true } : {}),
    hasAudio: muxed,
  };
}

function buildAudio(f: Json, prefix: string, cipher?: CipherManifest): AudioTrack | undefined {
  const url = formatUrl(f, cipher);
  const mime = str(f.mimeType) ?? '';
  const itag = f.itag;
  if (!url || typeof itag !== 'number' || !mime.startsWith('audio/')) return undefined;
  const codec = splitCodecString(/codecs="([^"]*)"/.exec(mime)?.[1]).audio;
  const bitrate = num(f.bitrate);
  const size = num(f.contentLength);
  const trackId = isObj(f.audioTrack) ? str(f.audioTrack.id) : undefined;
  const language = trackId?.split('.')[0];
  return {
    id: `${prefix}itag:${itag}`,
    kind: 'progressive',
    url,
    ...(codec ? { codec } : {}),
    ...(bitrate ? { bitrate } : {}),
    ...(language ? { language } : {}),
    ...(size ? { sizeBytes: size } : {}),
  };
}

interface Parsed {
  videoId: string;
  title?: string;
  duration?: number;
  variants: Variant[];
  audioTracks: AudioTrack[];
}

function parseResponse(r: unknown, prefix: string, cipher?: CipherManifest): Parsed | undefined {
  if (!isObj(r) || !isObj(r.videoDetails)) return undefined;
  if (isObj(r.playabilityStatus) && r.playabilityStatus.status !== 'OK') return undefined;
  const d = r.videoDetails;
  const videoId = str(d.videoId);
  if (!videoId || d.isLive === true) return undefined;
  // a SABR-only response may carry no usable streamingData; the source is still worth a lookup
  const sd = isObj(r.streamingData) ? r.streamingData : {};
  const muxed = (Array.isArray(sd.formats) ? sd.formats : []).filter(isObj);
  const adaptive = (Array.isArray(sd.adaptiveFormats) ? sd.adaptiveFormats : []).filter(isObj);
  const variants = [
    ...muxed.map((f) => buildVariant(f, true, prefix, cipher)),
    ...adaptive.map((f) => buildVariant(f, false, prefix, cipher)),
  ].filter((v): v is Variant => !!v);
  const audioTracks = adaptive
    .map((f) => buildAudio(f, prefix, cipher))
    .filter((a): a is AudioTrack => !!a);
  const title = str(d.title);
  const duration = num(d.lengthSeconds);
  return {
    videoId,
    ...(title ? { title } : {}),
    ...(duration ? { duration } : {}),
    variants,
    audioTracks,
  };
}

/** The video id the page URL itself shows: /watch?v=, /shorts/, /live/. */
function pageVideoId(pageUrl: string): string | undefined {
  try {
    const u = new URL(pageUrl);
    return u.searchParams.get('v') ?? /^\/(?:shorts|live)\/([\w-]{11})/.exec(u.pathname)?.[1];
  } catch {
    return undefined;
  }
}

function fromResponse(r: unknown, ctx: DetectContext): VideoSource | undefined {
  const p = parseResponse(r, '');
  if (!p) return undefined;
  const main = pageVideoId(ctx.pageUrl) === p.videoId;
  return {
    id: `youtube:${p.videoId}`,
    site: 'youtube',
    title: p.title ?? ctx.pageTitle,
    pageUrl: ctx.pageUrl,
    thumbnail: `https://i.ytimg.com/vi/${p.videoId}/hqdefault.jpg`,
    ...(p.duration ? { duration: p.duration } : {}),
    variants: p.variants,
    audioTracks: p.audioTracks,
    protection: 'none',
    detectedBy: ['adapter'],
    ...(main ? { mainVideo: true as const } : {}),
  };
}

/** `(3) Title - YouTube` -> `Title`. */
const cleanPageTitle = (t: string): string => t.replace(/^\(\d+\)\s*/, '').replace(/\s*-\s*YouTube$/, '').trim();

/**
 * The video the page URL names, before anything is known about it. `resolve`
 * fills it from the player API, like YoutubeExplode working from a link, so
 * a missed or wrong page payload (an ad's player response) cannot hide it.
 */
function fromPageUrl(videoId: string, ctx: DetectContext): VideoSource {
  return {
    id: `youtube:${videoId}`,
    site: 'youtube',
    title: cleanPageTitle(ctx.pageTitle) || videoId,
    pageUrl: ctx.pageUrl,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    variants: [],
    audioTracks: [],
    protection: 'none',
    detectedBy: ['adapter'],
    mainVideo: true,
  };
}

function detect(ctx: DetectContext): VideoSource[] {
  const pageId = pageVideoId(ctx.pageUrl);
  const out = new Map<string, VideoSource>();
  // Later payloads (SPA navigations, refreshed player responses) win.
  for (const p of ctx.tapped ?? []) {
    if (!isObj(p) || p.kind !== YT_TAP_KIND) continue;
    const src = fromResponse(p.response, ctx);
    // on a watch page only its own video counts: the player may report an ad
    if (src && (!pageId || src.id === `youtube:${pageId}`)) out.set(src.id, src);
  }
  if (pageId && !out.has(`youtube:${pageId}`)) out.set(`youtube:${pageId}`, fromPageUrl(pageId, ctx));
  return [...out.values()];
}

const needsResolve = (src: VideoSource): boolean =>
  !src.variants.some((v) => PLAYER_CLIENTS.some((c) => v.id.startsWith(c.prefix)));

/** Last cipher manifest read, by player version: base.js is about 2.5 MB. */
let cipherCache: { version: string; manifest: CipherManifest } | undefined;

async function cipherManifest(ctx: AdapterContext): Promise<CipherManifest | undefined> {
  try {
    const version = parsePlayerVersion(await ctx.fetchText(IFRAME_API_URL));
    if (!version) return undefined;
    if (cipherCache?.version === version) return cipherCache.manifest;
    const manifest = parseCipherManifest(await ctx.fetchText(baseJsUrl(version)));
    if (manifest) cipherCache = { version, manifest };
    return manifest;
  } catch {
    return undefined;
  }
}

/** Test hook: forget the cached cipher manifest. */
export function resetCipherCache(): void {
  cipherCache = undefined;
}

/**
 * Swap the page's variants for downloadable ones from the player API, trying
 * each client in turn (VISIONOS, ANDROID, then TV with the signature cipher).
 * If every client fails, the source is left as it was.
 */
async function resolve(src: VideoSource, ctx: AdapterContext): Promise<VideoSource> {
  const videoId = src.id.startsWith('youtube:') ? src.id.slice('youtube:'.length) : '';
  const postJson = ctx.postJson;
  if (!postJson || !videoId || !needsResolve(src)) return src;
  const visitorData = await ctx
    .fetchText(VISITOR_DATA_URL)
    .then(parseVisitorData, () => undefined);
  for (const client of PLAYER_CLIENTS) {
    const cipher = client.ciphered ? await cipherManifest(ctx) : undefined;
    if (client.ciphered && !cipher) continue;
    const reply = await postJson(
      PLAYER_ENDPOINT,
      client.requestBody(videoId, visitorData, cipher?.signatureTimestamp),
      client.requestHeaders,
    ).catch(() => undefined);
    const p = parseResponse(reply, client.prefix, cipher);
    if (!p || p.videoId !== videoId || !p.variants.length) continue;
    return {
      ...src,
      ...(p.title ? { title: p.title } : {}),
      ...(p.duration && !src.duration ? { duration: p.duration } : {}),
      variants: p.variants,
      audioTracks: p.audioTracks,
      headers: { ...src.headers, ...client.mediaHeaders },
    };
  }
  return src;
}

export const youtubeAdapter: SiteAdapter = {
  site: 'youtube',
  matches,
  detect,
  resolve,
  needsResolve,
};
