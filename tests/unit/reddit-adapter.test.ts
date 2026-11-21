import { describe, expect, it } from 'vitest';
import {
  redditAdapter,
  redditCanonicalId,
  redditDashSource,
  redditGifOriginal,
  redditMediaId,
  redditMpdUrl,
  redditPlayerMedia,
  redditPostContentMediaId,
  redditSourcesFromHtml,
} from '../../src/adapters/reddit';
import { pickAdapter } from '../../src/adapters/registry';
import type { AdapterContext } from '../../src/adapters/types';
import { parseMaster, parseMedia } from '../../src/core/media/hls';
import { parseMpd } from '../../src/core/media/dash';
import { mergeAll } from '../../src/core/rank';
import * as fx from '../fixtures/reddit-pages';

function adapterCtx(files: Record<string, string>): AdapterContext {
  return {
    fetchText: async (url) => {
      const t = files[url];
      if (t === undefined) throw new Error(`404 ${url}`);
      return t;
    },
    parseMaster,
    parseMedia,
    parseMpd,
  };
}

describe('reddit adapter: matching', () => {
  it('claims reddit hosts and is picked ahead of the generic adapter', () => {
    expect(redditAdapter.matches('https://www.reddit.com/r/x/')).toBe(true);
    expect(redditAdapter.matches('https://old.reddit.com/r/x/')).toBe(true);
    expect(redditAdapter.matches('https://example.com/')).toBe(false);
    expect(pickAdapter(fx.NEW_POST_URL).site).toBe('reddit');
  });
});

describe('reddit adapter: layouts', () => {
  it('new post: canonical id from the t3 post id, title from the post', () => {
    const [s, ...rest] = redditSourcesFromHtml(fx.NEW_POST_HTML, fx.NEW_POST_URL, 'tab title');
    expect(rest).toHaveLength(0);
    expect(s).toMatchObject({
      id: 'reddit:1abc23',
      site: 'reddit',
      title: 'Cat jumps',
      pageUrl: fx.NEW_POST_URL,
      thumbnail: 'https://preview.redd.it/k9x2m3q4.png',
      protection: 'none',
      detectedBy: ['adapter'],
    });
    expect(s!.variants).toMatchObject([{ kind: 'dash', url: fx.MPD_CMAF_URL, hasAudio: false }]);
  });

  it('old post: data-mpd-url is used as is, entities decoded', () => {
    const [s] = redditSourcesFromHtml(fx.OLD_POST_HTML, fx.OLD_POST_URL, 'tab');
    expect(s).toMatchObject({ id: 'reddit:2def45', title: 'Dog swims' });
    expect(s!.variants[0]!.url).toBe(fx.MPD_LEGACY_URL);
  });

  it('feed: one source per video post, image posts ignored, ids stable', () => {
    const found = redditSourcesFromHtml(fx.FEED_HTML, fx.FEED_URL, 'feed');
    expect(found.map((s) => [s.id, s.title])).toEqual([
      ['reddit:aaa111', 'First clip'],
      ['reddit:bbb222', 'Second clip'],
    ]);
    expect(redditSourcesFromHtml(fx.FEED_HTML, fx.FEED_URL, 'feed').map((s) => s.id)).toEqual(
      found.map((s) => s.id),
    );
  });

  it('comment video: gets its own id, separate from the post', () => {
    const [s] = redditSourcesFromHtml(fx.COMMENT_HTML, fx.COMMENT_URL, 'tab');
    expect(s!.id).toBe('reddit:c-kz9y8x');
    expect(s!.variants[0]!.url).toBe('https://v.redd.it/cmt999/DASHPlaylist.mpd');
  });

  it('shreddit-video-player with src: canonical post id, title, poster, and DASH url', () => {
    const [s] = redditSourcesFromHtml(fx.VIDEO_PLAYER_SRC_HTML, fx.VIDEO_PLAYER_SRC_URL, 'tab');
    expect(s).toMatchObject({
      id: 'reddit:4jkl89',
      title: 'New player',
      thumbnail: 'https://preview.redd.it/nvp111.png',
    });
    expect(s!.variants[0]!.url).toBe('https://v.redd.it/nvp111/DASHPlaylist.mpd');
  });

  it('shreddit-video-player with video-url: extracts media id and builds DASH url', () => {
    const [s] = redditSourcesFromHtml(
      fx.VIDEO_PLAYER_URL_ATTR_HTML,
      fx.VIDEO_PLAYER_URL_ATTR_URL,
      'tab',
    );
    expect(s).toMatchObject({
      id: 'reddit:5mno01',
      title: 'Video URL attr',
    });
    expect(s!.variants[0]!.url).toBe('https://v.redd.it/nvp222/DASHPlaylist.mpd');
  });

  it('shreddit-post content-href: detects v.redd.it video before player mounts, without duplicating when player is present', () => {
    const [lazy, ...extra] = redditSourcesFromHtml(
      fx.CONTENT_HREF_ONLY_HTML,
      fx.CONTENT_HREF_ONLY_URL,
      'tab',
    );
    expect(extra).toHaveLength(0);
    expect(lazy).toMatchObject({
      id: 'reddit:6pqr23',
      title: 'Lazy post',
    });
    expect(lazy!.variants[0]!.url).toBe('https://v.redd.it/lazy333/DASHPlaylist.mpd');

    // NEW_POST_HTML has both content-href and shreddit-player-2 for k9x2m3q4: still 1 source with poster
    const both = redditSourcesFromHtml(fx.NEW_POST_HTML, fx.NEW_POST_URL, 'tab');
    expect(both).toHaveLength(1);
    expect(both[0]!.thumbnail).toBe('https://preview.redd.it/k9x2m3q4.png');
  });
});

describe('reddit adapter: detect from network log', () => {
  it('reports a sniffed DASHPlaylist.mpd under its media id, at the canonical URL', () => {
    const found = redditAdapter.detect({
      pageUrl: fx.NEW_POST_URL,
      pageTitle: 'Cat jumps : r/videos',
      domVideos: [],
      network: [
        { url: `${fx.MPD_CMAF_URL}?a=1700000000%2Cabc&v=1&f=sd` },
        { url: 'https://v.redd.it/k9x2m3q4/CMAF_720.mp4' },
        { url: 'https://example.com/a.mp4' },
      ],
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      id: 'reddit:v-k9x2m3q4',
      site: 'reddit',
      detectedBy: ['network'],
    });
    // the player's `f=sd` query can narrow the renditions listed: the bare URL lists them all
    expect(found[0]!.variants[0]!.url).toBe(fx.MPD_CMAF_URL);
  });

  it('normalizes HLS playlists and CMAF/DASH MP4 segments on v.redd.it to canonical DASHPlaylist.mpd and deduplicates', () => {
    const found = redditAdapter.detect({
      pageUrl: fx.NEW_POST_URL,
      pageTitle: 'Cat jumps : r/videos',
      domVideos: [],
      network: [
        { url: 'https://v.redd.it/k9x2m3q4/HLSPlaylist.m3u8?a=123' },
        { url: 'https://v.redd.it/k9x2m3q4/HLS_720.m3u8' },
        { url: 'https://v.redd.it/k9x2m3q4/CMAF_720.mp4' },
        { url: 'https://v.redd.it/other123/DASH_480.mp4' },
        { url: 'https://example.com/other/HLSPlaylist.m3u8' },
        { url: 'https://v.redd.it/k9x2m3q4/thumb.jpg' },
      ],
    });
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({
      id: 'reddit:v-k9x2m3q4',
      site: 'reddit',
      detectedBy: ['network'],
      variants: [{ kind: 'dash', url: 'https://v.redd.it/k9x2m3q4/DASHPlaylist.mpd' }],
    });
    expect(found[1]).toMatchObject({
      id: 'reddit:v-other123',
      site: 'reddit',
      detectedBy: ['network'],
      variants: [{ kind: 'dash', url: 'https://v.redd.it/other123/DASHPlaylist.mpd' }],
    });
  });

  it('several videos on one comment page stay separate cards', () => {
    const found = redditAdapter.detect({
      pageUrl: fx.COMMENT_URL,
      pageTitle: 't',
      domVideos: [],
      network: [
        { url: 'https://v.redd.it/aaa111/DASHPlaylist.mpd' },
        { url: 'https://v.redd.it/bbb222/DASHPlaylist.mpd' },
      ],
    });
    expect(new Set(found.map((s) => s.id)).size).toBe(2);
  });

  it("a sniffed manifest folds onto the markup's card for the same video", () => {
    const fromHtml = redditSourcesFromHtml(fx.NEW_POST_HTML, fx.NEW_POST_URL, 't');
    const sniffed = redditAdapter.detect({
      pageUrl: fx.NEW_POST_URL,
      pageTitle: 't',
      domVideos: [],
      network: [{ url: `${fx.MPD_CMAF_URL}?f=sd` }],
    });
    const merged = mergeAll(sniffed, fromHtml);
    expect(merged.map((s) => s.id)).toEqual(['reddit:1abc23']);
  });

  it('shreddit-video-player and content-href finds fold with network-sniffed manifests', () => {
    const fromPlayer = redditSourcesFromHtml(
      fx.VIDEO_PLAYER_SRC_HTML,
      fx.VIDEO_PLAYER_SRC_URL,
      't',
    );
    const sniffedPlayer = redditAdapter.detect({
      pageUrl: fx.VIDEO_PLAYER_SRC_URL,
      pageTitle: 't',
      domVideos: [],
      network: [{ url: 'https://v.redd.it/nvp111/DASHPlaylist.mpd?f=sd' }],
    });
    expect(mergeAll(sniffedPlayer, fromPlayer).map((s) => s.id)).toEqual(['reddit:4jkl89']);

    const fromContentHref = redditSourcesFromHtml(
      fx.CONTENT_HREF_ONLY_HTML,
      fx.CONTENT_HREF_ONLY_URL,
      't',
    );
    const sniffedLazy = redditAdapter.detect({
      pageUrl: fx.CONTENT_HREF_ONLY_URL,
      pageTitle: 't',
      domVideos: [],
      network: [{ url: 'https://v.redd.it/lazy333/DASHPlaylist.mpd?f=sd' }],
    });
    expect(mergeAll(sniffedLazy, fromContentHref).map((s) => s.id)).toEqual(['reddit:6pqr23']);
  });
});

describe('redditGifOriginal', () => {
  it('maps a preview rendition (MP4 or still) back to the i.redd.it upload', () => {
    expect(redditGifOriginal('https://preview.redd.it/abc123.gif?format=mp4&s=deadbeef')).toBe(
      'https://i.redd.it/abc123.gif',
    );
    expect(
      redditGifOriginal(
        'https://preview.redd.it/funny-cat-v0-abc123.gif?width=640&format=png8&s=x',
      ),
    ).toBe('https://i.redd.it/abc123.gif');
    expect(redditGifOriginal('https://i.redd.it/abc123.gif')).toBe('https://i.redd.it/abc123.gif');
  });

  it('has no original for stills, other hosts or bad URLs', () => {
    expect(redditGifOriginal('https://preview.redd.it/abc123.jpg?format=pjpg')).toBeUndefined();
    expect(redditGifOriginal('https://external-preview.redd.it/x.gif?format=mp4')).toBeUndefined();
    expect(redditGifOriginal('not a url')).toBeUndefined();
  });
});

describe('reddit adapter: resolve', () => {
  const source = (html: string, url: string) => redditSourcesFromHtml(html, url, 't')[0]!;

  it('CMAF names: video renditions are silent variants, audio becomes audioTracks', async () => {
    const out = await redditAdapter.resolve!(
      source(fx.NEW_POST_HTML, fx.NEW_POST_URL),
      adapterCtx({ [fx.MPD_CMAF_URL]: fx.MPD_CMAF }),
    );
    expect(out.duration).toBe(12);
    expect(out.variants.map((v) => [v.height, v.hasAudio, v.kind])).toEqual([
      [720, false, 'dash'],
      [480, false, 'dash'],
    ]);
    expect(out.audioTracks).toMatchObject([
      { kind: 'dash', url: fx.MPD_CMAF_URL, bitrate: 128000 },
    ]);
  });

  it('legacy DASH_ names work the same', async () => {
    const out = await redditAdapter.resolve!(
      source(fx.OLD_POST_HTML, fx.OLD_POST_URL),
      adapterCtx({ [fx.MPD_LEGACY_URL]: fx.MPD_LEGACY }),
    );
    expect(out.variants).toHaveLength(1);
    expect(out.audioTracks).toHaveLength(1);
  });

  it('video without audio: no audio tracks', async () => {
    const out = await redditAdapter.resolve!(
      redditSourcesFromHtml(fx.FEED_HTML, fx.FEED_URL, 'f')[0]!,
      adapterCtx({ [fx.MPD_SILENT_URL]: fx.MPD_SILENT }),
    );
    expect(out.variants).toMatchObject([{ height: 360, hasAudio: false }]);
    expect(out.audioTracks).toEqual([]);
    // short and silent: what Reddit makes of an uploaded GIF
    expect(out.animatedGif).toBe(true);
  });

  it('a clip with sound is not offered as GIF', async () => {
    const out = await redditAdapter.resolve!(
      source(fx.NEW_POST_HTML, fx.NEW_POST_URL),
      adapterCtx({ [fx.MPD_CMAF_URL]: fx.MPD_CMAF }),
    );
    expect(out.animatedGif).toBeUndefined();
  });

  it('returns the source unchanged when the MPD cannot be fetched', async () => {
    const src = source(fx.NEW_POST_HTML, fx.NEW_POST_URL);
    expect(await redditAdapter.resolve!(src, adapterCtx({}))).toBe(src);
  });
});

describe('reddit adapter: exported DOM helpers', () => {
  const el = (tagName: string, attrs: Record<string, string> = {}, classes: string[] = []) => ({
    tagName,
    getAttribute: (name: string) => attrs[name] ?? null,
    classList: { contains: (cls: string) => classes.includes(cls) },
  });

  it('extracts v.redd.it media IDs and builds canonical DASHPlaylist.mpd URLs', () => {
    expect(redditMediaId('https://v.redd.it/k9x2m3q4/HLSPlaylist.m3u8?f=hd')).toBe('k9x2m3q4');
    expect(redditMediaId('https://v.redd.it/k9x2m3q4')).toBe('k9x2m3q4');
    expect(redditMediaId('https://example.com/k9x2m3q4/HLSPlaylist.m3u8')).toBeUndefined();
    expect(redditMediaId(null)).toBeUndefined();
    expect(redditMpdUrl('k9x2m3q4')).toBe('https://v.redd.it/k9x2m3q4/DASHPlaylist.mpd');
  });

  it('derives canonical IDs for comments, posts, URL fallback, and media-ID fallback', () => {
    expect(
      redditCanonicalId({
        mediaId: 'vid1',
        pageUrl: fx.COMMENT_URL,
        postId: 't3_3ghi67',
        commentId: 't1_kz9y8x',
      }),
    ).toBe('reddit:c-kz9y8x');
    expect(redditCanonicalId({ mediaId: 'vid1', pageUrl: fx.FEED_URL, postId: 't3_aaa111' })).toBe(
      'reddit:aaa111',
    );
    expect(redditCanonicalId({ mediaId: 'vid1', pageUrl: fx.NEW_POST_URL })).toBe('reddit:1abc23');
    expect(redditCanonicalId({ mediaId: 'vid1', pageUrl: fx.FEED_URL })).toBe('reddit:v-vid1');
  });

  it('constructs a canonical Reddit DASH VideoSource', () => {
    const src = redditDashSource({
      mediaId: 'k9x2m3q4',
      pageUrl: fx.NEW_POST_URL,
      title: 'Cat jumps',
      postId: 't3_1abc23',
      detectedBy: ['dom'],
      extra: { thumbnail: 'https://preview.redd.it/k9x2m3q4.png' },
    });
    expect(src).toMatchObject({
      id: 'reddit:1abc23',
      site: 'reddit',
      title: 'Cat jumps',
      pageUrl: fx.NEW_POST_URL,
      thumbnail: 'https://preview.redd.it/k9x2m3q4.png',
      detectedBy: ['dom'],
      variants: [
        {
          id: 'dash:k9x2m3q4',
          kind: 'dash',
          url: fx.MPD_CMAF_URL,
          container: 'fmp4',
          hasAudio: false,
        },
      ],
    });
  });

  it('recognizes new player elements (src / video-url), old player divs, and shreddit-post content-href', () => {
    expect(
      redditPlayerMedia(
        el('SHREDDIT-VIDEO-PLAYER', {
          src: 'https://v.redd.it/nvp111/HLSPlaylist.m3u8',
          poster: 'https://p.jpg',
        }),
      ),
    ).toEqual({
      mediaId: 'nvp111',
      poster: 'https://p.jpg',
    });
    expect(
      redditPlayerMedia(
        el('shreddit-video-player', { 'video-url': 'https://v.redd.it/nvp222/HLSPlaylist.m3u8' }),
      ),
    ).toEqual({
      mediaId: 'nvp222',
    });
    expect(
      redditPlayerMedia(
        el('DIV', { 'data-hls-url': 'https://v.redd.it/old111/HLSPlaylist.m3u8' }, [
          'reddit-video-player-root',
        ]),
      ),
    ).toEqual({
      mediaId: 'old111',
    });
    expect(
      redditPlayerMedia(el('div', { src: 'https://v.redd.it/x/DASHPlaylist.mpd' })),
    ).toBeUndefined();

    expect(
      redditPostContentMediaId(
        el('SHREDDIT-POST', { 'content-href': 'https://v.redd.it/lazy333' }),
      ),
    ).toBe('lazy333');
    expect(
      redditPostContentMediaId(
        el('shreddit-post', { 'content-href': 'https://i.redd.it/pic.jpg' }),
      ),
    ).toBeUndefined();
  });
});
