import { describe, expect, it } from "vitest";
import { xAdapter } from "../../src/adapters/x";
import { pickAdapter } from "../../src/adapters/registry";
import type { DetectContext, DomVideo } from "../../src/adapters/types";
import * as fx from "../fixtures/x-graphql";

const ctx = (over: Partial<DetectContext> = {}): DetectContext => ({
  pageUrl: `https://x.com/someone/status/${fx.TWEET_ID}`,
  pageTitle: "someone on X",
  domVideos: [],
  network: [],
  tapped: [],
  ...over,
});

const dom = (over: Partial<DomVideo> = {}): DomVideo => ({
  elementKey: "k1",
  frameId: 0,
  src: "blob:https://x.com/abc",
  rectWidth: 400,
  rectHeight: 700,
  visibleRatio: 1,
  playing: false,
  ...over,
});

describe("x adapter", () => {
  it("claims x.com and twitter.com, ahead of generic", () => {
    expect(xAdapter.matches("https://x.com/home")).toBe(true);
    expect(xAdapter.matches("https://mobile.twitter.com/a/status/1")).toBe(true);
    expect(xAdapter.matches("https://example.com/")).toBe(false);
    expect(pickAdapter("https://x.com/home").site).toBe("x");
  });

  it("turns each mp4 bitrate of a tweet detail into a variant, with HLS as fallback", () => {
    const [src, ...rest] = xAdapter.detect(ctx({ tapped: [fx.detail3Bitrates] }));
    expect(rest).toEqual([]);
    expect(src!.id).toBe(`x:${fx.TWEET_ID}:${fx.MEDIA_KEY}`);
    expect(src!.site).toBe("x");
    expect(src!.duration).toBe(12);
    const prog = src!.variants.filter((v) => v.kind === "progressive");
    expect(prog.map((v) => [v.bitrate, v.width, v.height])).toEqual([
      [2176000, 720, 1280],
      [832000, 480, 852],
      [256000, 320, 568],
    ]);
    expect(prog.every((v) => v.container === "mp4" && v.hasAudio)).toBe(true);
    const last = src!.variants.at(-1)!;
    expect(last.kind).toBe("hls");
    expect(last.url).toContain("master.m3u8");
  });

  it("takes acceptsRanges and size from the sniffer's hit for the same url", () => {
    const url = "https://video.twimg.com/ext_tw_video/1700000000000000001/pu/vid/avc1/720x1280/clip.mp4?tag=12";
    const [src] = xAdapter.detect(
      ctx({ tapped: [fx.detail3Bitrates], network: [{ url, acceptsRanges: true, contentLength: 5000 }] }),
    );
    const v = src!.variants.find((x) => x.url === url)!;
    expect(v.acceptsRanges).toBe(true);
    expect(v.sizeBytes).toBe(5000);
    expect(src!.variants.find((x) => x.height === 852)!.acceptsRanges).toBeUndefined();
  });

  it("finds both videos in a timeline and ignores photos, even visibility-wrapped tweets", () => {
    const out = xAdapter.detect(ctx({ pageUrl: "https://x.com/home", tapped: [fx.timeline2Videos] }));
    expect(out.map((s) => s.id)).toEqual([
      "x:1800000000000000001:7_1800000000000000001",
      "x:1800000000000000002:7_1800000000000000002",
    ]);
  });

  it("describes a GIF tweet as a silent single mp4", () => {
    const [src] = xAdapter.detect(ctx({ tapped: [fx.gifTweet] }));
    expect(src!.id).toBe("x:1900000000000000001:16_1900000000000000001");
    expect(src!.variants).toHaveLength(1);
    expect(src!.variants[0]).toMatchObject({ kind: "progressive", container: "mp4", hasAudio: false });
    expect(src!.animatedGif).toBe(true);
    expect(src!.gifUrl).toBeUndefined();
  });

  it("does not mark an ordinary video as a GIF", () => {
    const [src] = xAdapter.detect(ctx({ tapped: [fx.hlsOnlyTweet] }));
    expect(src!.animatedGif).toBeUndefined();
  });

  it("offers an HLS-only tweet as a single hls variant", () => {
    const [src] = xAdapter.detect(ctx({ tapped: [fx.hlsOnlyTweet] }));
    expect(src!.variants.map((v) => v.kind)).toEqual(["hls"]);
    expect(src!.variants[0]!.container).toBe("ts");
  });

  it("deduplicates a tweet seen in several payloads", () => {
    const out = xAdapter.detect(ctx({ tapped: [fx.detail3Bitrates, fx.detail3Bitrates] }));
    expect(out).toHaveLength(1);
  });

  it("ignores junk payloads", () => {
    expect(xAdapter.detect(ctx({ tapped: [null, 3, "x", { a: [] }] }))).toEqual([]);
  });

  it("matches the DOM <video> through the media id in its poster", () => {
    const poster = `https://pbs.twimg.com/ext_tw_video_thumb/${fx.TWEET_ID}/pu/img/zzz.jpg`;
    const [src] = xAdapter.detect(ctx({ tapped: [fx.detail3Bitrates], domVideos: [dom({ poster })] }));
    expect(src!.frameRef).toEqual({ frameId: 0, elementKey: "k1" });
    expect(src!.detectedBy).toEqual(expect.arrayContaining(["dom", "network"]));
    expect(src!.dom).toMatchObject({ visibleRatio: 1 });
  });

  it("does not attach an unrelated <video>", () => {
    const [src] = xAdapter.detect(
      ctx({
        tapped: [fx.detail3Bitrates],
        domVideos: [dom({ poster: "https://pbs.twimg.com/ext_tw_video_thumb/999/pu/img/z.jpg" })],
      }),
    );
    expect(src!.frameRef).toBeUndefined();
  });
});
