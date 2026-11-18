import { describe, expect, it } from "vitest";
import { redditAdapter, redditSourcesFromHtml } from "../../src/adapters/reddit";
import { pickAdapter } from "../../src/adapters/registry";
import type { AdapterContext } from "../../src/adapters/types";
import { parseMaster, parseMedia } from "../../src/core/media/hls";
import { parseMpd } from "../../src/core/media/dash";
import * as fx from "../fixtures/reddit-pages";

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

describe("reddit adapter: matching", () => {
  it("claims reddit hosts and is picked ahead of the generic adapter", () => {
    expect(redditAdapter.matches("https://www.reddit.com/r/x/")).toBe(true);
    expect(redditAdapter.matches("https://old.reddit.com/r/x/")).toBe(true);
    expect(redditAdapter.matches("https://example.com/")).toBe(false);
    expect(pickAdapter(fx.NEW_POST_URL).site).toBe("reddit");
  });
});

describe("reddit adapter: layouts", () => {
  it("new post: canonical id from the t3 post id, title from the post", () => {
    const [s, ...rest] = redditSourcesFromHtml(fx.NEW_POST_HTML, fx.NEW_POST_URL, "tab title");
    expect(rest).toHaveLength(0);
    expect(s).toMatchObject({
      id: "reddit:1abc23",
      site: "reddit",
      title: "Cat jumps",
      pageUrl: fx.NEW_POST_URL,
      thumbnail: "https://preview.redd.it/k9x2m3q4.png",
      protection: "none",
      detectedBy: ["adapter"],
    });
    expect(s!.variants).toMatchObject([{ kind: "dash", url: fx.MPD_CMAF_URL, hasAudio: false }]);
  });

  it("old post: data-mpd-url is used as is, entities decoded", () => {
    const [s] = redditSourcesFromHtml(fx.OLD_POST_HTML, fx.OLD_POST_URL, "tab");
    expect(s).toMatchObject({ id: "reddit:2def45", title: "Dog swims" });
    expect(s!.variants[0]!.url).toBe(fx.MPD_LEGACY_URL);
  });

  it("feed: one source per video post, image posts ignored, ids stable", () => {
    const found = redditSourcesFromHtml(fx.FEED_HTML, fx.FEED_URL, "feed");
    expect(found.map((s) => [s.id, s.title])).toEqual([
      ["reddit:aaa111", "First clip"],
      ["reddit:bbb222", "Second clip"],
    ]);
    expect(redditSourcesFromHtml(fx.FEED_HTML, fx.FEED_URL, "feed").map((s) => s.id)).toEqual(found.map((s) => s.id));
  });

  it("comment video: gets its own id, separate from the post", () => {
    const [s] = redditSourcesFromHtml(fx.COMMENT_HTML, fx.COMMENT_URL, "tab");
    expect(s!.id).toBe("reddit:c-kz9y8x");
    expect(s!.variants[0]!.url).toBe("https://v.redd.it/cmt999/DASHPlaylist.mpd");
  });
});

describe("reddit adapter: detect from network log", () => {
  it("reports a sniffed DASHPlaylist.mpd, with the post id taken from the page URL", () => {
    const found = redditAdapter.detect({
      pageUrl: fx.NEW_POST_URL,
      pageTitle: "Cat jumps : r/videos",
      domVideos: [],
      network: [{ url: fx.MPD_CMAF_URL }, { url: "https://v.redd.it/k9x2m3q4/CMAF_720.mp4" }, { url: "https://example.com/a.mp4" }],
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id: "reddit:1abc23", site: "reddit", detectedBy: ["network"] });
  });
});

describe("reddit adapter: resolve", () => {
  const source = (html: string, url: string) => redditSourcesFromHtml(html, url, "t")[0]!;

  it("CMAF names: video renditions are silent variants, audio becomes audioTracks", async () => {
    const out = await redditAdapter.resolve!(source(fx.NEW_POST_HTML, fx.NEW_POST_URL), adapterCtx({ [fx.MPD_CMAF_URL]: fx.MPD_CMAF }));
    expect(out.duration).toBe(12);
    expect(out.variants.map((v) => [v.height, v.hasAudio, v.kind])).toEqual([
      [720, false, "dash"],
      [480, false, "dash"],
    ]);
    expect(out.audioTracks).toMatchObject([{ kind: "dash", url: fx.MPD_CMAF_URL, bitrate: 128000 }]);
  });

  it("legacy DASH_ names work the same", async () => {
    const out = await redditAdapter.resolve!(source(fx.OLD_POST_HTML, fx.OLD_POST_URL), adapterCtx({ [fx.MPD_LEGACY_URL]: fx.MPD_LEGACY }));
    expect(out.variants).toHaveLength(1);
    expect(out.audioTracks).toHaveLength(1);
  });

  it("video without audio: no audio tracks", async () => {
    const out = await redditAdapter.resolve!(redditSourcesFromHtml(fx.FEED_HTML, fx.FEED_URL, "f")[0]!, adapterCtx({ [fx.MPD_SILENT_URL]: fx.MPD_SILENT }));
    expect(out.variants).toMatchObject([{ height: 360, hasAudio: false }]);
    expect(out.audioTracks).toEqual([]);
  });

  it("returns the source unchanged when the MPD cannot be fetched", async () => {
    const src = source(fx.NEW_POST_HTML, fx.NEW_POST_URL);
    expect(await redditAdapter.resolve!(src, adapterCtx({}))).toBe(src);
  });
});
