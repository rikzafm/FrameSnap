import { describe, expect, it } from "vitest";
import { genericAdapter } from "../../src/adapters/generic";
import { domVideosFromHtml } from "../../src/adapters/html";
import { pickAdapter } from "../../src/adapters/registry";
import type { AdapterContext, DetectContext } from "../../src/adapters/types";
import { parseMaster, parseMedia } from "../../src/core/media/hls";
import { parseMpd } from "../../src/core/media/dash";
import { mergeAll } from "../../src/core/rank";
import * as fx from "../fixtures/hls-page";

const detectCtx = (over: Partial<DetectContext> = {}): DetectContext => ({
  pageUrl: fx.PAGE_URL,
  pageTitle: "Intro clip - Example Videos",
  domVideos: [],
  network: [],
  ...over,
});

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

describe("generic adapter: detect", () => {
  it("finds http(s) <video> elements in fixture HTML and ignores blob: sources", () => {
    const domVideos = domVideosFromHtml(fx.PAGE_HTML, fx.PAGE_URL);
    expect(domVideos.map((v) => v.src)).toEqual(["blob:https://videos.example.org/9f1c", "https://cdn.example.org/clips/teaser.mp4"]);

    const found = genericAdapter.detect(detectCtx({ domVideos }));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      site: "generic",
      title: "Intro clip - Example Videos",
      pageUrl: fx.PAGE_URL,
      protection: "none",
      detectedBy: ["dom"],
    });
    expect(found[0]!.variants).toMatchObject([{ kind: "progressive", url: "https://cdn.example.org/clips/teaser.mp4", container: "mp4", hasAudio: true }]);
    expect(found[0]!.dom).toMatchObject({ rectWidth: 320, rectHeight: 180 });
  });

  it("turns a sniffed network log into sources with sizes and range support", () => {
    const found = genericAdapter.detect(
      detectCtx({
        network: [
          { url: "https://cdn.example.org/a.mp4", contentType: "video/mp4", contentLength: 5_000_000, acceptsRanges: true },
          { url: fx.MASTER_URL, contentType: "application/vnd.apple.mpegurl" },
          { url: fx.MPD_URL },
        ],
      }),
    );
    const kinds = found.flatMap((s) => s.variants.map((v) => [v.kind, v.sizeBytes, v.acceptsRanges]));
    expect(kinds).toEqual([
      ["progressive", 5_000_000, true],
      ["hls", undefined, undefined],
      ["dash", undefined, undefined],
    ]);
    expect(found.every((s) => s.detectedBy.join() === "network")).toBe(true);
  });

  it("gives DOM and network finds for the same URL the same source after merging", () => {
    const url = "https://cdn.example.org/clips/teaser.mp4";
    const dom = genericAdapter.detect(detectCtx({ domVideos: domVideosFromHtml(fx.PAGE_HTML, fx.PAGE_URL) }));
    const net = genericAdapter.detect(detectCtx({ network: [{ url, contentType: "video/mp4", contentLength: 123, acceptsRanges: true }] }));
    const merged = mergeAll(dom, net);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.detectedBy.sort()).toEqual(["dom", "network"]);
    expect(merged[0]!.variants[0]).toMatchObject({ sizeBytes: 123, acceptsRanges: true });
  });

  it("matches only http(s) pages and is the registry fallback", () => {
    expect(genericAdapter.matches("https://a.test/x")).toBe(true);
    expect(genericAdapter.matches("chrome://extensions")).toBe(false);
    expect(pickAdapter("https://a.test/x")).toBe(genericAdapter);
  });
});

describe("generic adapter: resolve", () => {
  const hlsFind = () => genericAdapter.detect(detectCtx({ network: [{ url: fx.MASTER_URL }] }))[0]!;

  it("expands an HLS master into variants with resolution, size estimate, audio tracks", async () => {
    const ctx = adapterCtx({
      [fx.MASTER_URL]: fx.MASTER,
      "https://cdn.example.org/hls/720p.m3u8": fx.MEDIA_VOD,
    });
    const out = await genericAdapter.resolve!(hlsFind(), ctx);
    expect(out.id).toBe(hlsFind().id);
    expect(out.duration).toBe(30);
    expect(out.variants.map((v) => [v.height, v.kind, v.live])).toEqual([
      [720, "hls", false],
      [360, "hls", false],
    ]);
    // 2.5 Mbit/s * 30 s
    expect(out.variants[0]!.sizeBytes).toBe(Math.round((2_500_000 / 8) * 30));
    expect(out.variants[0]).toMatchObject({ url: "https://cdn.example.org/hls/720p.m3u8", width: 1280, hasAudio: false, container: "ts" });
    expect(out.audioTracks).toMatchObject([{ kind: "hls", url: "https://cdn.example.org/hls/audio/en.m3u8", language: "en" }]);
    expect(out.protection).toBe("none");
  });

  it("flags live and DRM playlists from the parsers", async () => {
    const live = await genericAdapter.resolve!(hlsFind(), adapterCtx({ [fx.MASTER_URL]: fx.MASTER, "https://cdn.example.org/hls/720p.m3u8": fx.MEDIA_LIVE }));
    expect(live.variants.every((v) => v.live === true)).toBe(true);
    expect(live.duration).toBeUndefined();

    const drm = await genericAdapter.resolve!(hlsFind(), adapterCtx({ [fx.MASTER_URL]: fx.MASTER, "https://cdn.example.org/hls/720p.m3u8": fx.MEDIA_DRM }));
    expect(drm.protection).toBe("drm");
  });

  it("treats a bare media playlist as a single variant", async () => {
    const out = await genericAdapter.resolve!(hlsFind(), adapterCtx({ [fx.MASTER_URL]: fx.MEDIA_VOD }));
    expect(out.variants).toHaveLength(1);
    expect(out.variants[0]).toMatchObject({ kind: "hls", url: fx.MASTER_URL, live: false });
    expect(out.duration).toBe(30);
  });

  it("expands a DASH manifest into video variants and audio tracks", async () => {
    const find = genericAdapter.detect(detectCtx({ network: [{ url: fx.MPD_URL }] }))[0]!;
    const out = await genericAdapter.resolve!(find, adapterCtx({ [fx.MPD_URL]: fx.MPD }));
    expect(out.duration).toBe(20);
    expect(out.variants.map((v) => [v.id, v.height, v.url, v.hasAudio])).toEqual([
      ["v2", 1080, fx.MPD_URL, false],
      ["v1", 480, fx.MPD_URL, false],
    ]);
    expect(out.variants[0]!.sizeBytes).toBe((3_000_000 / 8) * 20);
    expect(out.audioTracks).toMatchObject([{ id: "a1", kind: "dash", url: fx.MPD_URL }]);
  });

  it("returns the source unchanged when the manifest cannot be fetched", async () => {
    const find = hlsFind();
    expect(await genericAdapter.resolve!(find, adapterCtx({}))).toEqual(find);
  });

  it("leaves progressive sources alone", async () => {
    const find = genericAdapter.detect(detectCtx({ network: [{ url: "https://c.test/a.mp4", contentType: "video/mp4" }] }))[0]!;
    expect(await genericAdapter.resolve!(find, adapterCtx({}))).toBe(find);
  });
});

describe("merge keeps DASH representations apart", () => {
  it("does not collapse variants that share the MPD url", async () => {
    const find = genericAdapter.detect(detectCtx({ network: [{ url: fx.MPD_URL }] }))[0]!;
    const out = await genericAdapter.resolve!(find, adapterCtx({ [fx.MPD_URL]: fx.MPD }));
    const merged = mergeAll([out], [out]);
    expect(merged[0]!.variants.map((v) => v.id)).toEqual(["v2", "v1"]);
  });
});
