/**
 * Reddit adapter (spec §6.4, §F6). Reddit serves video as DASH whole files:
 * silent video renditions plus a separate audio rendition, all listed in
 * `https://v.redd.it/<id>/DASHPlaylist.mpd`. Video representations become
 * variants (`hasAudio: false`) and audio representations become `audioTracks`,
 * so the planner adds the audio track on its own. Both `CMAF_*` and legacy
 * `DASH_*` file names work, because representations are classified by their
 * AdaptationSet, not by name.
 */
import type { AudioTrack, Variant, VideoSource } from '../core/model';
import { splitCodecString } from './codec-strings';
import type { AdapterContext, DetectContext, SiteAdapter } from './types';

// --- Selectors and URL patterns (everything site-specific lives here) ---
const HOST_RE = /(^|\.)reddit\.com$/i;
const MEDIA_HOST = 'v.redd.it';
const MEDIA_ID_RE = /^https?:\/\/v\.redd\.it\/([^/?#]+)/i;
const MPD_FILE = 'DASHPlaylist.mpd';
const POST_ID_IN_URL_RE = /\/comments\/([a-z0-9]+)/i;
/** New layout: custom elements (their shadow content must be serialized in). */
export const REDDIT_NEW_POST_TAG = 'shreddit-post';
export const REDDIT_NEW_COMMENT_TAG = 'shreddit-comment';
export const REDDIT_NEW_PLAYER_TAGS: ReadonlySet<string> = new Set([
  'shreddit-player',
  'shreddit-player-2',
  'shreddit-video-player',
]);
/** Old layout. */
export const REDDIT_OLD_THING_CLASS = 'thing';
export const REDDIT_OLD_PLAYER_CLASS = 'reddit-video-player-root';
export const REDDIT_OLD_TITLE_CLASS = 'title';
const T3 = /^t3_/i;
const T1 = /^t1_/i;
// -------------------------------------------------------------------------

/** A silent v.redd.it clip this short is most likely an uploaded GIF (detection only, not a length limit). */
const GIF_LIKE_MAX_SECONDS = 60;
const GIF_ORIGINAL_HOST = 'i.redd.it';
const GIF_PREVIEW_HOST = 'preview.redd.it';
/** New preview names put a slug before the media id: `my-title-v0-<id>.gif`. */
const PREVIEW_SLUG_RE = /^.*-v0-/;

/**
 * The original upload behind a Reddit GIF rendition. `preview.redd.it/<id>.gif`
 * is served as MP4 (`format=mp4`) or a still (`format=png8`) of the file kept
 * at `i.redd.it/<id>.gif`. Other hosts (external-preview, imgur) have no
 * derivable original.
 */
export function redditGifOriginal(url: string): string | undefined {
  try {
    const u = new URL(url);
    const name = u.pathname.split('/').pop() ?? '';
    if (!/\.gif$/i.test(name)) return undefined;
    if (u.hostname === GIF_ORIGINAL_HOST) return `https://${GIF_ORIGINAL_HOST}/${name}`;
    if (u.hostname === GIF_PREVIEW_HOST)
      return `https://${GIF_ORIGINAL_HOST}/${name.replace(PREVIEW_SLUG_RE, '')}`;
    return undefined;
  } catch {
    return undefined;
  }
}

const decode = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(attrs);
  const v = m ? (m[1] ?? m[2]) : undefined;
  return v === undefined ? undefined : decode(v);
}

const hasClass = (attrs: string, cls: string) =>
  (attr(attrs, 'class') ?? '').split(/\s+/).includes(cls);

/** Extract the `v.redd.it` media ID from a media or manifest URL. */
export const redditMediaId = (url: string | null | undefined): string | undefined =>
  url ? MEDIA_ID_RE.exec(url)?.[1] : undefined;

/**
 * The canonical manifest URL. The player's own request carries a query
 * (`?a=…&v=1&f=sd`) that can narrow the renditions listed, and differs from
 * what the page markup names, so every find uses the bare URL: it lists every
 * rendition and lets network, DOM and markup finds meet on one card.
 */
export const redditMpdUrl = (id: string): string => `https://${MEDIA_HOST}/${id}/${MPD_FILE}`;

const MEDIA_EXT_RE = /\.(m3u8|mpd|mp4)$/i;

function isMediaRequest(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === MEDIA_HOST && MEDIA_EXT_RE.test(u.pathname);
  } catch {
    return false;
  }
}
const postIdFromUrl = (pageUrl: string) => POST_ID_IN_URL_RE.exec(pageUrl)?.[1];

export interface RedditCanonicalIdOptions {
  mediaId: string;
  pageUrl: string;
  postId?: string;
  commentId?: string;
}

/** Derive the canonical source ID for a Reddit post, comment, URL, or media ID. */
export function redditCanonicalId({
  mediaId,
  pageUrl,
  postId,
  commentId,
}: RedditCanonicalIdOptions): string {
  const cleanComment = commentId?.replace(T1, '');
  if (cleanComment) return `reddit:c-${cleanComment}`;
  const cleanPost = postId?.replace(T3, '');
  if (cleanPost) return `reddit:${cleanPost}`;
  const urlPost = postIdFromUrl(pageUrl);
  return `reddit:${urlPost ?? `v-${mediaId}`}`;
}

export interface RedditDashSourceOptions extends RedditCanonicalIdOptions {
  title: string;
  detectedBy: VideoSource['detectedBy'];
  extra?: Partial<VideoSource>;
  id?: string;
}

/** Construct a canonical Reddit DASH `VideoSource` from a `v.redd.it` media ID and context. */
export function redditDashSource({
  title,
  detectedBy,
  extra = {},
  id,
  ...idOpts
}: RedditDashSourceOptions): VideoSource {
  const sourceId = id ?? redditCanonicalId(idOpts);
  const mpdUrl = redditMpdUrl(idOpts.mediaId);
  const variant: Variant = {
    id: `dash:${idOpts.mediaId || sourceId}`,
    kind: 'dash',
    url: mpdUrl,
    container: 'fmp4',
    hasAudio: false,
  };
  return {
    id: sourceId,
    site: 'reddit',
    title,
    pageUrl: idOpts.pageUrl,
    variants: [variant],
    audioTracks: [],
    protection: 'none',
    detectedBy,
    ...extra,
  };
}

export interface UpsertRedditDashSourceOptions extends RedditCanonicalIdOptions {
  pageTitle: string;
  postTitle?: string;
  poster?: string;
}

/**
 * Insert a canonical Reddit DASH source into `byMpd` (keyed by MPD URL),
 * or backfill `thumbnail` on an existing entry if missing. Returns the MPD URL.
 */
export function upsertRedditDashSource(
  byMpd: Map<string, VideoSource>,
  { pageTitle, postTitle, poster, ...idOpts }: UpsertRedditDashSourceOptions,
): string {
  const mpdUrl = redditMpdUrl(idOpts.mediaId);
  const existing = byMpd.get(mpdUrl);
  if (existing) {
    if (poster && !existing.thumbnail) existing.thumbnail = poster;
    return mpdUrl;
  }
  const title = idOpts.commentId ? pageTitle : (postTitle ?? pageTitle);
  const src = redditDashSource({
    ...idOpts,
    title,
    detectedBy: ['adapter'],
    extra: poster ? { thumbnail: poster } : {},
  });
  byMpd.set(mpdUrl, src);
  return mpdUrl;
}

export interface RedditElementLike {
  tagName: string;
  getAttribute(name: string): string | null;
  classList?: { contains(token: string): boolean };
}

/** Extract `v.redd.it` media ID (and optional poster) from a recognized Reddit player element. */
export function redditPlayerMedia(
  el: RedditElementLike,
): { mediaId: string; poster?: string } | undefined {
  const tag = el.tagName.toLowerCase();
  if (REDDIT_NEW_PLAYER_TAGS.has(tag)) {
    const id = redditMediaId(el.getAttribute('src')) ?? redditMediaId(el.getAttribute('video-url'));
    if (!id) return undefined;
    const poster = el.getAttribute('poster') ?? undefined;
    return poster ? { mediaId: id, poster } : { mediaId: id };
  }
  if (tag === 'div' && el.classList?.contains(REDDIT_OLD_PLAYER_CLASS)) {
    const id =
      redditMediaId(el.getAttribute('data-mpd-url')) ??
      redditMediaId(el.getAttribute('data-hls-url'));
    return id ? { mediaId: id } : undefined;
  }
  return undefined;
}

/** Extract `v.redd.it` media ID from a `<shreddit-post>` element's `content-href` attribute. */
export function redditPostContentMediaId(el: RedditElementLike): string | undefined {
  if (el.tagName.toLowerCase() !== REDDIT_NEW_POST_TAG) return undefined;
  return redditMediaId(el.getAttribute('content-href'));
}

const htmlElement = (tagName: string, attrs: string): RedditElementLike => ({
  tagName,
  getAttribute: (name) => attr(attrs, name) ?? null,
  classList: { contains: (cls) => hasClass(attrs, cls) },
});

/**
 * Find video players in serialized page HTML (new and old layouts, feeds and
 * comment pages). Content scripts serialize the live DOM including open shadow
 * roots; tests feed fixtures.
 */
export function redditSourcesFromHtml(
  html: string,
  pageUrl: string,
  pageTitle: string,
): VideoSource[] {
  const byMpd = new Map<string, VideoSource>();
  let post: { id?: string; title?: string } = {};
  let commentId: string | undefined;
  let awaitingOldTitle = false;

  const add = (mediaId: string, poster?: string) =>
    upsertRedditDashSource(byMpd, {
      mediaId,
      pageUrl,
      pageTitle,
      postTitle: post.title,
      postId: post.id,
      commentId,
      poster,
    });

  const tagRe = /<([a-z][a-z0-9-]*)\b([^>]*)>([^<]*)/gi;
  for (let m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    const tag = m[1]!.toLowerCase();
    const attrs = m[2] ?? '';
    const text = decode((m[3] ?? '').trim());
    if (tag === REDDIT_NEW_POST_TAG) {
      post = { id: attr(attrs, 'id')?.replace(T3, ''), title: attr(attrs, 'post-title') };
      commentId = undefined;
      const contentId = redditMediaId(attr(attrs, 'content-href'));
      if (contentId) add(contentId);
    } else if (
      tag === 'div' &&
      hasClass(attrs, REDDIT_OLD_THING_CLASS) &&
      /^t3_/i.test(attr(attrs, 'data-fullname') ?? '')
    ) {
      post = { id: attr(attrs, 'data-fullname')!.replace(T3, '') };
      commentId = undefined;
      awaitingOldTitle = true;
    } else if (tag === REDDIT_NEW_COMMENT_TAG) {
      commentId = attr(attrs, 'thingid')?.replace(T1, '');
    } else if (tag === 'a' && awaitingOldTitle && hasClass(attrs, REDDIT_OLD_TITLE_CLASS)) {
      if (text) post.title = text;
      awaitingOldTitle = false;
    } else {
      const player = redditPlayerMedia(htmlElement(tag, attrs));
      if (player) add(player.mediaId, player.poster);
    }
  }
  return [...byMpd.values()];
}

/**
 * Sniffed and DOM finds. A page can hold several videos (a post plus comment
 * clips), so a find is keyed by its media id, not the page's post id: the
 * registry folds it onto the adapter's card through the shared canonical MPD URL.
 */
function detect(ctx: DetectContext): VideoSource[] {
  const out: VideoSource[] = [];
  const seen = new Set<string>();
  const push = (url: string, by: 'network' | 'dom', extra: Partial<VideoSource> = {}) => {
    const vid = redditMediaId(url);
    if (!vid) return;
    const mpd = redditMpdUrl(vid);
    if (seen.has(mpd)) return;
    seen.add(mpd);
    out.push(
      redditDashSource({
        id: `reddit:v-${vid}`,
        mediaId: vid,
        pageUrl: ctx.pageUrl,
        title: ctx.pageTitle,
        detectedBy: [by],
        extra,
      }),
    );
  };
  for (const hit of ctx.network) if (isMediaRequest(hit.url)) push(hit.url, 'network');
  for (const v of ctx.domVideos) {
    push(v.src, 'dom', {
      ...(v.poster ? { thumbnail: v.poster } : {}),
      frameRef: { frameId: v.frameId, elementKey: v.elementKey },
      dom: {
        visibleRatio: v.visibleRatio,
        rectWidth: v.rectWidth,
        rectHeight: v.rectHeight,
        playing: v.playing,
      },
    });
  }
  return out;
}

const estimateBytes = (bandwidth: number, duration: number | undefined) =>
  bandwidth > 0 && duration ? Math.round((bandwidth / 8) * duration) : undefined;

async function resolve(src: VideoSource, ctx: AdapterContext): Promise<VideoSource> {
  const manifest = src.variants.find((v) => v.kind === 'dash');
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
          kind: 'dash',
          url: manifest.url,
          container: 'fmp4',
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
      kind: 'dash',
      url: manifest.url,
      ...(r.codecs ? { codec: r.codecs } : {}),
      bitrate: r.bandwidth,
      ...(r.language ? { language: r.language } : {}),
    }));
    // Reddit turns an uploaded GIF into a silent v.redd.it clip; a short silent clip is offered as GIF too
    const gifLike =
      !mpd.live &&
      mpd.audio.length === 0 &&
      mpd.duration !== undefined &&
      mpd.duration <= GIF_LIKE_MAX_SECONDS;
    return {
      ...src,
      ...(gifLike ? { animatedGif: true as const } : {}),
      ...(mpd.duration !== undefined && !mpd.live ? { duration: mpd.duration } : {}),
      protection: mpd.protection === 'drm' ? 'drm' : src.protection,
      variants: variants.length ? variants : src.variants,
      audioTracks,
    };
  } catch {
    return src;
  }
}

export const redditAdapter: SiteAdapter = {
  site: 'reddit',
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
