/**
 * X (Twitter) adapter. Video URLs are not in the DOM (the <video> is a blob:
 * MSE stream), so the main-world network tap forwards GraphQL JSON and this
 * adapter reads `extended_entities.media[].video_info.variants` out of it.
 */
import type { Variant, VideoSource } from "../core/model";
import type { DetectContext, DomVideo, NetworkHit, SiteAdapter } from "./types";

const HOST_RE = /^(?:[a-z0-9-]+\.)*(?:x|twitter)\.com$/i;

function matches(pageUrl: string): boolean {
  try {
    const u = new URL(pageUrl);
    return /^https?:$/.test(u.protocol) && HOST_RE.test(u.hostname);
  } catch {
    return false;
  }
}

type Json = Record<string, unknown>;
const isObj = (x: unknown): x is Json => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === "string" && x ? x : undefined);

interface TweetMedia {
  tweetId: string;
  media: Json;
  text: string;
}

/** Depth-first walk collecting every tweet object that carries video/gif media. */
function collect(node: unknown, out: TweetMedia[], depth = 0): void {
  if (depth > 40) return;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, out, depth + 1);
    return;
  }
  if (!isObj(node)) return;
  const legacy = node.legacy;
  const restId = str(node.rest_id);
  if (restId && isObj(legacy)) {
    const ext = legacy.extended_entities;
    const list = isObj(ext) && Array.isArray(ext.media) ? ext.media : [];
    for (const m of list) {
      if (isObj(m) && (m.type === "video" || m.type === "animated_gif") && isObj(m.video_info)) {
        out.push({ tweetId: restId, media: m, text: str(legacy.full_text) ?? "" });
      }
    }
  }
  for (const v of Object.values(node)) collect(v, out, depth + 1);
}

function sizeFromUrl(url: string): { width: number; height: number } | undefined {
  const m = /\/(\d{2,5})x(\d{2,5})\//.exec(url);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : undefined;
}

const stripQuery = (u: string) => u.split("?")[0]!.split("#")[0]!;

function buildSource(t: TweetMedia, ctx: DetectContext, hits: Map<string, NetworkHit>): VideoSource | undefined {
  const info = t.media.video_info as Json;
  const raw = Array.isArray(info.variants) ? info.variants : [];
  const isGif = t.media.type === "animated_gif";
  const progressive: Variant[] = [];
  const hls: Variant[] = [];
  for (const rv of raw) {
    if (!isObj(rv)) continue;
    const url = str(rv.url);
    if (!url) continue;
    const ct = str(rv.content_type) ?? "";
    if (ct.includes("mpegURL") || stripQuery(url).endsWith(".m3u8")) {
      hls.push({ id: "hls:master", kind: "hls", url, container: "ts", hasAudio: true });
    } else if (ct.includes("mp4") || stripQuery(url).endsWith(".mp4")) {
      const bitrate = typeof rv.bitrate === "number" ? rv.bitrate : 0;
      const hit = hits.get(stripQuery(url));
      progressive.push({
        id: `mp4:${bitrate}`,
        kind: "progressive",
        url,
        container: "mp4",
        ...(sizeFromUrl(url) ?? {}),
        ...(bitrate > 0 ? { bitrate } : {}),
        ...(hit?.contentLength !== undefined ? { sizeBytes: hit.contentLength } : {}),
        ...(hit?.acceptsRanges !== undefined ? { acceptsRanges: hit.acceptsRanges } : {}),
        hasAudio: !isGif,
      });
    }
  }
  progressive.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  const variants = [...progressive, ...hls];
  if (!variants.length) return undefined;
  const mediaKey = str(t.media.media_key) ?? str(t.media.id_str) ?? "0";
  const durationMs = info.duration_millis;
  const thumb = str(t.media.media_url_https);
  return {
    id: `x:${t.tweetId}:${mediaKey}`,
    site: "x",
    title: t.text ? t.text.slice(0, 120) : ctx.pageTitle,
    pageUrl: ctx.pageUrl,
    ...(thumb ? { thumbnail: thumb } : {}),
    ...(typeof durationMs === "number" && durationMs > 0 ? { duration: durationMs / 1000 } : {}),
    variants,
    audioTracks: [],
    protection: "none",
    detectedBy: ["network"],
  };
}

/** The tweet's <video> poster is `.../<media id>/pu/img/...`; match on that id. */
function matchDom(mediaId: string, videos: readonly DomVideo[]): DomVideo | undefined {
  return videos.find((v) => !!v.poster && v.poster.includes(`/${mediaId}/`));
}

function detect(ctx: DetectContext): VideoSource[] {
  const found: TweetMedia[] = [];
  for (const payload of ctx.tapped ?? []) collect(payload, found);
  const hits = new Map(ctx.network.map((h) => [stripQuery(h.url), h]));
  const out = new Map<string, VideoSource>();
  for (const t of found) {
    const src = buildSource(t, ctx, hits);
    if (!src || out.has(src.id)) continue;
    const mediaId = str(t.media.id_str);
    const v = mediaId ? matchDom(mediaId, ctx.domVideos) : undefined;
    if (v) {
      src.frameRef = { frameId: v.frameId, elementKey: v.elementKey };
      src.dom = { visibleRatio: v.visibleRatio, rectWidth: v.rectWidth, rectHeight: v.rectHeight, playing: v.playing };
      src.detectedBy = ["dom", "network"];
    }
    out.set(src.id, src);
  }
  return [...out.values()];
}

export const xAdapter: SiteAdapter = { site: "x", matches, detect };
