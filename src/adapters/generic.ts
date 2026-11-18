/**
 * Generic adapter: any http(s) page. Reports `<video>` elements with a
 * direct URL and every URL the network sniffer saw. HLS and DASH manifests are
 * expanded into variants and audio tracks on `resolve`.
 */
import type { AudioTrack, Container, Variant, VideoSource } from "../core/model";
import type { HlsMaster, HlsMedia } from "../core/media/hls";
import { isMasterPlaylist, audioRenditionFor } from "../core/media/hls";
import { splitCodecString } from "./codec-strings";
import type { AdapterContext, DetectContext, DomVideo, NetworkHit, SiteAdapter } from "./types";

type Kind = "progressive" | "hls" | "dash";

export function mediaKind(url: string, contentType?: string): Kind {
  const ct = (contentType ?? "").toLowerCase();
  let path = url.toLowerCase();
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    /* keep raw */
  }
  if (path.endsWith(".m3u8") || ct.includes("mpegurl")) return "hls";
  if (path.endsWith(".mpd") || ct.includes("dash+xml")) return "dash";
  return "progressive";
}

function containerFor(url: string, contentType: string | undefined, kind: Kind): Container {
  if (kind === "hls") return "ts";
  if (kind === "dash") return "fmp4";
  const ct = (contentType ?? "").toLowerCase();
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return url.toLowerCase();
    }
  })();
  if (path.endsWith(".webm") || ct.includes("webm")) return "webm";
  if (path.endsWith(".mp4") || path.endsWith(".m4v") || ct.includes("mp4")) return "mp4";
  return "unknown";
}

/** Short stable hash (djb2) for ids. Not security-relevant. */
function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const stripHash = (url: string) => url.split("#")[0]!;
const idFor = (url: string) => `generic:${hash(stripHash(url))}`;

function isHttp(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function variantFor(url: string, contentType: string | undefined, extra: Partial<Variant> = {}): Variant {
  const kind = mediaKind(url, contentType);
  return {
    id: `${kind}:${hash(stripHash(url))}`,
    kind,
    url,
    container: containerFor(url, contentType, kind),
    hasAudio: true,
    ...extra,
  };
}

function baseSource(ctx: DetectContext, url: string, variant: Variant, by: "dom" | "network"): VideoSource {
  return {
    id: idFor(url),
    site: "generic",
    title: ctx.pageTitle,
    pageUrl: ctx.pageUrl,
    variants: [variant],
    audioTracks: [],
    protection: "none",
    detectedBy: [by],
  };
}

function fromDom(ctx: DetectContext, v: DomVideo): VideoSource {
  const variant = variantFor(v.src, undefined, v.videoHeight ? { width: v.videoWidth, height: v.videoHeight } : {});
  return {
    ...baseSource(ctx, v.src, variant, "dom"),
    ...(v.poster ? { thumbnail: v.poster } : {}),
    ...(v.duration !== undefined && Number.isFinite(v.duration) ? { duration: v.duration } : {}),
    frameRef: { frameId: v.frameId, elementKey: v.elementKey },
    dom: { visibleRatio: v.visibleRatio, rectWidth: v.rectWidth, rectHeight: v.rectHeight, playing: v.playing },
  };
}

function fromNetwork(ctx: DetectContext, hit: NetworkHit): VideoSource {
  const variant = variantFor(hit.url, hit.contentType, {
    ...(hit.contentLength !== undefined ? { sizeBytes: hit.contentLength } : {}),
    ...(hit.acceptsRanges !== undefined ? { acceptsRanges: hit.acceptsRanges } : {}),
  });
  return baseSource(ctx, hit.url, variant, "network");
}

function detect(ctx: DetectContext): VideoSource[] {
  const out: VideoSource[] = [];
  for (const v of ctx.domVideos) if (isHttp(v.src)) out.push(fromDom(ctx, v));
  for (const hit of ctx.network) if (isHttp(hit.url)) out.push(fromNetwork(ctx, hit));
  return out;
}

const estimateBytes = (bandwidth: number, duration: number | undefined) =>
  bandwidth > 0 && duration ? Math.round((bandwidth / 8) * duration) : undefined;

async function resolveHls(src: VideoSource, variant: Variant, ctx: AdapterContext): Promise<VideoSource> {
  const text = await ctx.fetchText(variant.url, src.headers);
  if (!isMasterPlaylist(text)) {
    const media = ctx.parseMedia(text, variant.url);
    return {
      ...src,
      ...(media.live ? {} : { duration: media.totalDuration }),
      protection: media.protection === "drm" ? "drm" : src.protection,
      variants: [{ ...variant, container: media.container, live: media.live }],
    };
  }
  const master: HlsMaster = ctx.parseMaster(text, variant.url);
  // The master does not say whether the stream is live or protected; ask the best media playlist.
  let probe: HlsMedia | undefined;
  const best = master.variants[0];
  if (best) {
    try {
      probe = ctx.parseMedia(await ctx.fetchText(best.uri, src.headers), best.uri);
    } catch {
      probe = undefined;
    }
  }
  const duration = probe && !probe.live ? probe.totalDuration : undefined;
  const audioTracks = new Map<string, AudioTrack>();
  const variants: Variant[] = master.variants.map((hv) => {
    const rendition = audioRenditionFor(master, hv);
    if (rendition?.uri && !audioTracks.has(rendition.uri)) {
      audioTracks.set(rendition.uri, {
        id: `hls-audio:${hash(rendition.uri)}`,
        kind: "hls",
        url: rendition.uri,
        ...(rendition.language ? { language: rendition.language } : {}),
      });
    }
    const codecs = splitCodecString(hv.codecs);
    return {
      id: `hls:${hv.height ?? 0}p:${hv.bandwidth}`,
      kind: "hls",
      url: hv.uri,
      container: probe?.container ?? "ts",
      ...(codecs.video ? { videoCodec: codecs.video } : {}),
      ...(codecs.audio ? { audioCodec: codecs.audio } : {}),
      ...(hv.width ? { width: hv.width } : {}),
      ...(hv.height ? { height: hv.height } : {}),
      bitrate: hv.bandwidth,
      ...(estimateBytes(hv.bandwidth, duration) !== undefined ? { sizeBytes: estimateBytes(hv.bandwidth, duration) } : {}),
      hasAudio: !rendition?.uri,
      ...(probe ? { live: probe.live } : {}),
    };
  });
  return {
    ...src,
    ...(duration !== undefined ? { duration } : {}),
    protection: probe?.protection === "drm" ? "drm" : src.protection,
    variants,
    audioTracks: [...audioTracks.values()],
  };
}

async function resolveDash(src: VideoSource, variant: Variant, ctx: AdapterContext): Promise<VideoSource> {
  const mpd = ctx.parseMpd(await ctx.fetchText(variant.url, src.headers), variant.url);
  const variants: Variant[] = [...mpd.video]
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth)
    .map((r) => {
      const codecs = splitCodecString(r.codecs);
      return {
        id: r.id,
        kind: "dash",
        url: variant.url,
        container: "fmp4",
        ...(codecs.video ? { videoCodec: codecs.video } : {}),
        ...(codecs.audio ? { audioCodec: codecs.audio } : {}),
        ...(r.width ? { width: r.width } : {}),
        ...(r.height ? { height: r.height } : {}),
        bitrate: r.bandwidth,
        ...(estimateBytes(r.bandwidth, mpd.duration) !== undefined ? { sizeBytes: estimateBytes(r.bandwidth, mpd.duration) } : {}),
        hasAudio: false,
        live: mpd.live,
      };
    });
  const audioTracks: AudioTrack[] = mpd.audio.map((r) => ({
    id: r.id,
    kind: "dash",
    url: variant.url,
    ...(r.codecs ? { codec: r.codecs } : {}),
    bitrate: r.bandwidth,
    ...(r.language ? { language: r.language } : {}),
  }));
  return {
    ...src,
    ...(mpd.duration !== undefined && !mpd.live ? { duration: mpd.duration } : {}),
    protection: mpd.protection === "drm" ? "drm" : src.protection,
    variants: variants.length ? variants : src.variants,
    audioTracks,
  };
}

async function resolve(src: VideoSource, ctx: AdapterContext): Promise<VideoSource> {
  const manifest = src.variants.find((v) => v.kind === "hls" || v.kind === "dash");
  if (!manifest) return src;
  try {
    return manifest.kind === "hls" ? await resolveHls(src, manifest, ctx) : await resolveDash(src, manifest, ctx);
  } catch {
    return src;
  }
}

export const genericAdapter: SiteAdapter = {
  site: "generic",
  matches: (pageUrl) => isHttp(pageUrl),
  detect,
  resolve,
};
