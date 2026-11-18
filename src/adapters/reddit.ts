/**
 * Reddit adapter (spec §6.4, §F6). Reddit serves video as DASH whole files:
 * silent video renditions plus a separate audio rendition, all listed in
 * `https://v.redd.it/<id>/DASHPlaylist.mpd`. Video representations become
 * variants (`hasAudio: false`) and audio representations become `audioTracks`,
 * so the planner adds the audio track on its own. Both `CMAF_*` and legacy
 * `DASH_*` file names work, because representations are classified by their
 * AdaptationSet, not by name.
 */
import type { AudioTrack, Variant, VideoSource } from "../core/model";
import { splitCodecString } from "./codec-strings";
import type { AdapterContext, DetectContext, SiteAdapter } from "./types";

// --- Selectors and URL patterns (everything site-specific lives here) ---
const HOST_RE = /(^|\.)reddit\.com$/i;
const MEDIA_HOST = "v.redd.it";
const MEDIA_ID_RE = /^https?:\/\/v\.redd\.it\/([^/?#]+)/i;
const MPD_FILE = "DASHPlaylist.mpd";
const POST_ID_IN_URL_RE = /\/comments\/([a-z0-9]+)/i;
/** New layout: custom elements (their shadow content must be serialized in). */
const NEW_POST_TAG = "shreddit-post";
const NEW_COMMENT_TAG = "shreddit-comment";
const NEW_PLAYER_TAGS = new Set(["shreddit-player", "shreddit-player-2"]);
/** Old layout. */
const OLD_THING_CLASS = "thing";
const OLD_PLAYER_CLASS = "reddit-video-player-root";
const OLD_TITLE_CLASS = "title";
const T3 = /^t3_/i;
const T1 = /^t1_/i;
// -------------------------------------------------------------------------

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attrs);
  const v = m ? (m[1] ?? m[2]) : undefined;
  return v === undefined ? undefined : decode(v);
}

const hasClass = (attrs: string, cls: string) => (attr(attrs, "class") ?? "").split(/\s+/).includes(cls);

const mediaId = (url: string | undefined) => (url ? MEDIA_ID_RE.exec(url)?.[1] : undefined);
const mpdFor = (id: string) => `https://${MEDIA_HOST}/${id}/${MPD_FILE}`;
const postIdFromUrl = (pageUrl: string) => POST_ID_IN_URL_RE.exec(pageUrl)?.[1];

function isMpd(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === MEDIA_HOST && u.pathname.endsWith(`/${MPD_FILE}`);
  } catch {
    return false;
  }
}

function makeSource(
  id: string,
  mpdUrl: string,
  title: string,
  pageUrl: string,
  detectedBy: VideoSource["detectedBy"],
  extra: Partial<VideoSource> = {},
): VideoSource {
  const variant: Variant = {
    id: `dash:${mediaId(mpdUrl) ?? id}`,
    kind: "dash",
    url: mpdUrl,
    container: "fmp4",
    hasAudio: false,
  };
  return { id, site: "reddit", title, pageUrl, variants: [variant], audioTracks: [], protection: "none", detectedBy, ...extra };
}

/**
 * Find video players in serialized page HTML (new and old layouts, feeds and
 * comment pages). Content scripts serialize the live DOM including open shadow
 * roots; tests feed fixtures.
 */
export function redditSourcesFromHtml(html: string, pageUrl: string, pageTitle: string): VideoSource[] {
  const out: VideoSource[] = [];
  const seen = new Set<string>();
  let post: { id?: string; title?: string } = {};
  let commentId: string | undefined;
  let awaitingOldTitle = false;

  const add = (mpdUrl: string, poster: string | undefined) => {
    if (seen.has(mpdUrl)) return;
    seen.add(mpdUrl);
    const vid = mediaId(mpdUrl) ?? mpdUrl;
    const id = commentId ? `reddit:c-${commentId}` : post.id ? `reddit:${post.id}` : `reddit:${postIdFromUrl(pageUrl) ?? `v-${vid}`}`;
    const title = commentId ? pageTitle : (post.title ?? pageTitle);
    out.push(makeSource(id, mpdUrl, title, pageUrl, ["adapter"], poster ? { thumbnail: poster } : {}));
  };

  const tagRe = /<([a-z][a-z0-9-]*)\b([^>]*)>([^<]*)/gi;
  for (let m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    const tag = m[1]!.toLowerCase();
    const attrs = m[2] ?? "";
    const text = decode((m[3] ?? "").trim());
    if (tag === NEW_POST_TAG) {
      post = { id: attr(attrs, "id")?.replace(T3, ""), title: attr(attrs, "post-title") };
      commentId = undefined;
    } else if (tag === "div" && hasClass(attrs, OLD_THING_CLASS) && /^t3_/i.test(attr(attrs, "data-fullname") ?? "")) {
      post = { id: attr(attrs, "data-fullname")!.replace(T3, "") };
      commentId = undefined;
      awaitingOldTitle = true;
    } else if (tag === NEW_COMMENT_TAG) {
      commentId = attr(attrs, "thingid")?.replace(T1, "");
    } else if (tag === "a" && awaitingOldTitle && hasClass(attrs, OLD_TITLE_CLASS)) {
      if (text) post.title = text;
      awaitingOldTitle = false;
    } else if (NEW_PLAYER_TAGS.has(tag)) {
      const id = mediaId(attr(attrs, "src"));
      if (id) add(mpdFor(id), attr(attrs, "poster"));
    } else if (tag === "div" && hasClass(attrs, OLD_PLAYER_CLASS)) {
      const mpd = attr(attrs, "data-mpd-url");
      const id = mediaId(attr(attrs, "data-hls-url"));
      if (mpd) add(mpd, undefined);
      else if (id) add(mpdFor(id), undefined);
    }
  }
  return out;
}

function detect(ctx: DetectContext): VideoSource[] {
  const out: VideoSource[] = [];
  const seen = new Set<string>();
  const postId = postIdFromUrl(ctx.pageUrl);
  const push = (url: string, by: "network" | "dom", extra: Partial<VideoSource> = {}) => {
    const vid = mediaId(url);
    if (!vid) return;
    const mpd = isMpd(url) ? url : mpdFor(vid);
    if (seen.has(mpd)) return;
    seen.add(mpd);
    out.push(makeSource(`reddit:${postId ?? `v-${vid}`}`, mpd, ctx.pageTitle, ctx.pageUrl, [by], extra));
  };
  for (const hit of ctx.network) if (isMpd(hit.url)) push(hit.url, "network");
  for (const v of ctx.domVideos) {
    push(v.src, "dom", {
      ...(v.poster ? { thumbnail: v.poster } : {}),
      frameRef: { frameId: v.frameId, elementKey: v.elementKey },
      dom: { visibleRatio: v.visibleRatio, rectWidth: v.rectWidth, rectHeight: v.rectHeight, playing: v.playing },
    });
  }
  return out;
}

const estimateBytes = (bandwidth: number, duration: number | undefined) =>
  bandwidth > 0 && duration ? Math.round((bandwidth / 8) * duration) : undefined;

async function resolve(src: VideoSource, ctx: AdapterContext): Promise<VideoSource> {
  const manifest = src.variants.find((v) => v.kind === "dash");
  if (!manifest) return src;
  try {
    const mpd = ctx.parseMpd(await ctx.fetchText(manifest.url, src.headers), manifest.url);
    const variants: Variant[] = [...mpd.video]
      .sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth)
      .map((r) => {
        const codecs = splitCodecString(r.codecs);
        const size = estimateBytes(r.bandwidth, mpd.duration);
        return {
          id: r.id,
          kind: "dash",
          url: manifest.url,
          container: "fmp4",
          ...(codecs.video ? { videoCodec: codecs.video } : {}),
          ...(r.width ? { width: r.width } : {}),
          ...(r.height ? { height: r.height } : {}),
          bitrate: r.bandwidth,
          ...(size !== undefined ? { sizeBytes: size } : {}),
          hasAudio: false,
          live: mpd.live,
        };
      });
    const audioTracks: AudioTrack[] = mpd.audio.map((r) => ({
      id: r.id,
      kind: "dash",
      url: manifest.url,
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
  } catch {
    return src;
  }
}

export const redditAdapter: SiteAdapter = {
  site: "reddit",
  matches: (pageUrl) => {
    try {
      return HOST_RE.test(new URL(pageUrl).hostname);
    } catch {
      return false;
    }
  },
  detect,
  resolve,
};
