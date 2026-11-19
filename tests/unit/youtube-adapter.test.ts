import { describe, expect, it } from "vitest";
import { resetCipherCache, youtubeAdapter } from "../../src/adapters/youtube";
import { IFRAME_API_URL, baseJsUrl, decipher, parseCipherManifest } from "../../src/adapters/youtube-cipher";
import { FAKE_BASE_JS } from "../helpers/fake-base-js";
import { buildManifest } from "../../src/manifest";
import type { AdapterContext, DetectContext } from "../../src/adapters/types";
import { ANDROID, PLAYER_ENDPOINT, TV, VISITOR_DATA_URL, parseVisitorData, playerRequestBody } from "../../src/adapters/youtube-innertube";
import type { VideoSource } from "../../src/core/model";

const VID = "dQw4w9WgXcQ";
const playerResponse = {
  playabilityStatus: { status: "OK" },
  videoDetails: { videoId: VID, title: "A talk", lengthSeconds: "212", isLive: false },
  streamingData: {
    formats: [
      { itag: 18, url: "https://rr1.googlevideo.com/videoplayback?itag=18", mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', bitrate: 500000, width: 640, height: 360, contentLength: "9000000" },
    ],
    adaptiveFormats: [
      { itag: 137, url: "https://rr1.googlevideo.com/videoplayback?itag=137", mimeType: 'video/mp4; codecs="avc1.640028"', bitrate: 4000000, width: 1920, height: 1080, contentLength: "50000000" },
      { itag: 248, url: "https://rr1.googlevideo.com/videoplayback?itag=248", mimeType: 'video/webm; codecs="vp9"', bitrate: 2500000, width: 1920, height: 1080, contentLength: "30000000" },
      { itag: 140, url: "https://rr1.googlevideo.com/videoplayback?itag=140", mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130000, contentLength: "3400000", audioTrack: { id: "en.4" } },
      { itag: 251, url: "https://rr1.googlevideo.com/videoplayback?itag=251", mimeType: 'audio/webm; codecs="opus"', bitrate: 120000, contentLength: "3300000" },
      { itag: 299, signatureCipher: "s=abc&url=https%3A%2F%2Fx", mimeType: 'video/mp4; codecs="avc1.64002a"', bitrate: 9000000, width: 1920, height: 1080 },
    ],
  },
};

const ctx = (over: Partial<DetectContext> = {}): DetectContext => ({
  pageUrl: `https://www.youtube.com/watch?v=${VID}`,
  pageTitle: "A talk - YouTube",
  domVideos: [],
  network: [],
  tapped: [{ kind: "youtube-player", response: playerResponse }],
  ...over,
});

describe("youtube adapter", () => {
  it("claims youtube.com pages only", () => {
    expect(youtubeAdapter.matches("https://www.youtube.com/watch?v=x")).toBe(true);
    expect(youtubeAdapter.matches("https://m.youtube.com/watch?v=x")).toBe(true);
    expect(youtubeAdapter.matches("https://example.com/")).toBe(false);
  });

  it("splits adaptive formats into silent video variants and audio tracks", () => {
    const [src, ...rest] = youtubeAdapter.detect(ctx());
    expect(rest).toEqual([]);
    expect(src!.id).toBe(`youtube:${VID}`);
    expect(src!.site).toBe("youtube");
    expect(src!.title).toBe("A talk");
    expect(src!.duration).toBe(212);
    const adaptive = src!.variants.filter((v) => !v.hasAudio);
    expect(adaptive.map((v) => [v.id, v.container, v.height, v.sizeBytes])).toEqual([
      ["itag:137", "mp4", 1080, 50000000],
      ["itag:248", "webm", 1080, 30000000],
    ]);
    expect(src!.audioTracks.map((a) => [a.id, a.codec, a.sizeBytes])).toEqual([
      ["itag:140", "mp4a.40.2", 3400000],
      ["itag:251", "opus", 3300000],
    ]);
    expect(src!.audioTracks[0]!.language).toBe("en");
  });

  it("keeps muxed formats as variants with audio", () => {
    const [src] = youtubeAdapter.detect(ctx());
    const muxed = src!.variants.filter((v) => v.hasAudio);
    expect(muxed.map((v) => [v.id, v.height, v.videoCodec, v.audioCodec])).toEqual([["itag:18", 360, "avc1.42001E", "mp4a.40.2"]]);
  });

  it("marks URLs without ratebypass=yes as throttled", () => {
    const withBypass = { ...playerResponse, streamingData: { formats: [{ ...playerResponse.streamingData.formats[0]!, url: "https://rr1.googlevideo.com/videoplayback?itag=18&ratebypass=yes" }], adaptiveFormats: [] } };
    expect(youtubeAdapter.detect(ctx())[0]!.variants.every((v) => v.throttled)).toBe(true);
    expect(youtubeAdapter.detect(ctx({ tapped: [{ kind: "youtube-player", response: withBypass }] }))[0]!.variants[0]!.throttled).toBeUndefined();
  });

  it("drops ciphered formats that have no direct url", () => {
    const [src] = youtubeAdapter.detect(ctx());
    expect(src!.variants.some((v) => v.id === "itag:299")).toBe(false);
  });

  it("ignores unplayable, live and malformed payloads", () => {
    const bad = { ...playerResponse, playabilityStatus: { status: "LOGIN_REQUIRED" } };
    const live = { ...playerResponse, videoDetails: { ...playerResponse.videoDetails, isLive: true } };
    expect(youtubeAdapter.detect(ctx({ tapped: [{ kind: "youtube-player", response: bad }] }))).toEqual([]);
    expect(youtubeAdapter.detect(ctx({ tapped: [{ kind: "youtube-player", response: live }] }))).toEqual([]);
    expect(youtubeAdapter.detect(ctx({ tapped: [null, 5, { kind: "youtube-player" }, { foo: 1 }] }))).toEqual([]);
  });

  it("uses the newest payload when the same video is tapped twice", () => {
    const older = { ...playerResponse, videoDetails: { ...playerResponse.videoDetails, title: "Old" } };
    const out = youtubeAdapter.detect(ctx({ tapped: [{ kind: "youtube-player", response: older }, { kind: "youtube-player", response: playerResponse }] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe("A talk");
  });
});

/** What the page's WEB client gets under SABR: the video, but no format with a URL. */
const sabrOnly = {
  playabilityStatus: { status: "OK" },
  videoDetails: { videoId: VID, title: "A talk", lengthSeconds: "212", isLive: false },
  streamingData: {
    serverAbrStreamingUrl: "https://rr1.googlevideo.com/videoplayback?sabr=1",
    adaptiveFormats: [{ itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', width: 1920, height: 1080 }],
  },
};

const visionosReply = {
  playabilityStatus: { status: "OK" },
  videoDetails: { videoId: VID, title: "A talk", lengthSeconds: "212" },
  streamingData: {
    adaptiveFormats: [
      { itag: 137, url: "https://rr2.googlevideo.com/videoplayback?itag=137&c=VISIONOS", mimeType: 'video/mp4; codecs="avc1.640028"', bitrate: 4000000, width: 1920, height: 1080, contentLength: "50000000" },
      { itag: 140, url: "https://rr2.googlevideo.com/videoplayback?itag=140&c=VISIONOS", mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130000, contentLength: "3400000" },
    ],
  },
};

const XSSI = ")]}'";
const swJsData = (visitor: string) => XSSI + JSON.stringify([[null, null, [[[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, visitor]]]]]);

type Post = { url: string; body: unknown; headers?: Readonly<Record<string, string>> };

function adapterCtx(over: Partial<AdapterContext> = {}): AdapterContext & { posts: Post[] } {
  const posts: Post[] = [];
  return {
    posts,
    fetchText: async (url) => {
      if (url !== VISITOR_DATA_URL) throw new Error(`unexpected ${url}`);
      return swJsData("CgtWSVNJVE9S");
    },
    postJson: async (url, body, headers) => {
      posts.push({ url, body, ...(headers ? { headers } : {}) });
      return visionosReply;
    },
    parseMaster: (() => undefined) as never,
    parseMedia: (() => undefined) as never,
    parseMpd: (() => undefined) as never,
    ...over,
  };
}

describe("youtube VISIONOS lookup", () => {
  const sabrSource = (): VideoSource => youtubeAdapter.detect(ctx({ tapped: [{ kind: "youtube-player", response: sabrOnly }] }))[0]!;

  it("still reports a SABR-only page, with no variants yet", () => {
    const src = sabrSource();
    expect(src.id).toBe(`youtube:${VID}`);
    expect(src.variants).toEqual([]);
    expect(youtubeAdapter.needsResolve!(src)).toBe(true);
  });

  it("reports a page whose response has no streamingData at all", () => {
    const bare: Record<string, unknown> = { ...sabrOnly };
    delete bare.streamingData;
    expect(youtubeAdapter.detect(ctx({ tapped: [{ kind: "youtube-player", response: bare }] }))).toHaveLength(1);
  });

  it("asks the player API as VISIONOS with the visitor data and swaps in its plain URLs", async () => {
    const c = adapterCtx();
    const out = await youtubeAdapter.resolve!(sabrSource(), c);
    expect(c.posts).toHaveLength(1);
    expect(c.posts[0]!.url).toBe(PLAYER_ENDPOINT);
    expect(c.posts[0]!.body).toEqual(playerRequestBody(VID, "CgtWSVNJVE9S"));
    expect(c.posts[0]!.headers?.["User-Agent"]).toMatch(/Safari/);
    expect(out.variants.map((v) => [v.id, v.url])).toEqual([["vos:itag:137", "https://rr2.googlevideo.com/videoplayback?itag=137&c=VISIONOS"]]);
    expect(out.audioTracks.map((a) => a.id)).toEqual(["vos:itag:140"]);
    expect(out.headers?.["User-Agent"]).toMatch(/Safari/);
    expect(youtubeAdapter.needsResolve!(out)).toBe(false);
  });

  it("replaces throttled WEB URLs too, then stops asking", async () => {
    const [web] = youtubeAdapter.detect(ctx());
    expect(youtubeAdapter.needsResolve!(web!)).toBe(true);
    const c = adapterCtx();
    const out = await youtubeAdapter.resolve!(web!, c);
    expect(out.variants.every((v) => v.id.startsWith("vos:"))).toBe(true);
    await youtubeAdapter.resolve!(out, c);
    expect(c.posts).toHaveLength(1);
  });

  it("goes on without visitor data when sw.js_data fails", async () => {
    const c = adapterCtx({
      fetchText: async () => {
        throw new Error("offline");
      },
    });
    const out = await youtubeAdapter.resolve!(sabrSource(), c);
    expect(c.posts[0]!.body).toEqual(playerRequestBody(VID));
    expect(out.variants).toHaveLength(1);
  });

  it("leaves the source alone on a failed, unplayable, empty or mismatched reply", async () => {
    const src = sabrSource();
    const replies: unknown[] = [
      { ...visionosReply, playabilityStatus: { status: "UNPLAYABLE" } },
      { ...visionosReply, streamingData: { adaptiveFormats: [] } },
      { ...visionosReply, videoDetails: { videoId: "other" } },
      "nonsense",
    ];
    for (const reply of replies) expect(await youtubeAdapter.resolve!(src, adapterCtx({ postJson: async () => reply }))).toBe(src);
    const failing = adapterCtx({
      postJson: async () => {
        throw new Error("403");
      },
    });
    expect(await youtubeAdapter.resolve!(src, failing)).toBe(src);
    const noPost: AdapterContext = { ...adapterCtx() };
    delete noPost.postJson;
    expect(await youtubeAdapter.resolve!(src, noPost)).toBe(src);
  });

  const androidReply = {
    ...visionosReply,
    streamingData: {
      adaptiveFormats: [
        { itag: 137, url: "https://rr2.googlevideo.com/videoplayback?itag=137&c=ANDROID", mimeType: 'video/mp4; codecs="avc1.640028"', width: 1920, height: 1080 },
        { itag: 140, url: "https://rr2.googlevideo.com/videoplayback?itag=140&c=ANDROID", mimeType: 'audio/mp4; codecs="mp4a.40.2"' },
      ],
    },
  };

  it("falls back to the ANDROID client when VISIONOS says unplayable, and downloads with its User-Agent", async () => {
    const posts: Post[] = [];
    const c = adapterCtx({
      postJson: async (url, body, headers) => {
        posts.push({ url, body, ...(headers ? { headers } : {}) });
        return posts.length === 1 ? { ...visionosReply, playabilityStatus: { status: "UNPLAYABLE" } } : androidReply;
      },
    });
    const out = await youtubeAdapter.resolve!(sabrSource(), c);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toEqual(ANDROID.requestBody(VID, "CgtWSVNJVE9S"));
    expect((posts[1]!.body as { context: { client: { clientName: string } } }).context.client.clientName).toBe("ANDROID");
    expect(posts[1]!.headers?.["User-Agent"]).toMatch(/com\.google\.android\.youtube/);
    expect(out.variants.map((v) => v.id)).toEqual(["and:itag:137"]);
    expect(out.audioTracks.map((a) => a.id)).toEqual(["and:itag:140"]);
    expect(out.headers?.["User-Agent"]).toMatch(/com\.google\.android\.youtube/);
    expect(youtubeAdapter.needsResolve!(out)).toBe(false);
  });

  it("falls back to ANDROID when the VISIONOS request itself fails", async () => {
    let n = 0;
    const c = adapterCtx({
      postJson: async () => {
        if (n++ === 0) throw new Error("400");
        return androidReply;
      },
    });
    const out = await youtubeAdapter.resolve!(sabrSource(), c);
    expect(out.variants.map((v) => v.id)).toEqual(["and:itag:137"]);
  });

  it("falls back to the TV client with the signature cipher when VISIONOS and ANDROID are unplayable", async () => {
    resetCipherCache();
    const unplayable = { ...visionosReply, playabilityStatus: { status: "UNPLAYABLE" } };
    const media = "https://rr3.googlevideo.com/videoplayback?itag=137&c=TVHTML5";
    const tvReply = {
      ...visionosReply,
      streamingData: {
        adaptiveFormats: [
          { itag: 137, signatureCipher: new URLSearchParams({ s: "ABCDEFGHIJKLMNOP", sp: "sig", url: media }).toString(), mimeType: 'video/mp4; codecs="avc1.640028"', width: 1920, height: 1080 },
        ],
      },
    };
    const fetched: string[] = [];
    const posts: Post[] = [];
    const c = adapterCtx({
      fetchText: async (url) => {
        fetched.push(url);
        if (url === VISITOR_DATA_URL) return swJsData("CgtWSVNJVE9S");
        if (url === IFRAME_API_URL) return String.raw`'https:\/\/www.youtube.com\/s\/player\/0b866fa6\/www-widgetapi.vflset\/x.js'`;
        if (url === baseJsUrl("0b866fa6")) return FAKE_BASE_JS;
        throw new Error(`unexpected ${url}`);
      },
      postJson: async (url, body, headers) => {
        posts.push({ url, body, ...(headers ? { headers } : {}) });
        return posts.length < 3 ? unplayable : tvReply;
      },
    });
    const out = await youtubeAdapter.resolve!(sabrSource(), c);
    expect(posts).toHaveLength(3);
    expect(posts[2]!.body).toEqual(TV.requestBody(VID, "CgtWSVNJVE9S", "20123"));
    expect(posts[2]!.body).toMatchObject({
      context: { client: { clientName: "TVHTML5_SIMPLY_EMBEDDED_PLAYER" }, thirdParty: { embedUrl: "https://www.youtube.com" } },
      playbackContext: { contentPlaybackContext: { signatureTimestamp: 20123 } },
    });
    expect(out.variants.map((v) => v.id)).toEqual(["tv:itag:137"]);
    const sig = new URL(out.variants[0]!.url).searchParams.get("sig");
    expect(sig).toBe(decipher(parseCipherManifest(FAKE_BASE_JS)!, "ABCDEFGHIJKLMNOP"));
    expect(out.headers?.["User-Agent"]).toBe(TV.mediaHeaders["User-Agent"]);
    expect(youtubeAdapter.needsResolve!(out)).toBe(false);

    // the manifest is cached per player version: base.js is not fetched again
    await youtubeAdapter.resolve!(sabrSource(), c);
    expect(fetched.filter((u) => u === baseJsUrl("0b866fa6"))).toHaveLength(1);
  });

  it("skips the TV client when base.js cannot be read", async () => {
    resetCipherCache();
    const unplayable = { ...visionosReply, playabilityStatus: { status: "UNPLAYABLE" } };
    const posts: Post[] = [];
    const c = adapterCtx({
      postJson: async (url, body) => {
        posts.push({ url, body });
        return unplayable;
      },
    });
    const src = sabrSource();
    expect(await youtubeAdapter.resolve!(src, c)).toBe(src);
    expect(posts).toHaveLength(2);
  });

  it("parses visitor data and rejects anything else", () => {
    expect(parseVisitorData(swJsData("abc"))).toBe("abc");
    expect(parseVisitorData(XSSI + "[]")).toBeUndefined();
    expect(parseVisitorData("<html>")).toBeUndefined();
  });
});

describe("youtube build gating", () => {
  it("registers YouTube content scripts only in the personal manifest", () => {
    const has = (m: ReturnType<typeof buildManifest>) => JSON.stringify(m.content_scripts).includes("youtube");
    expect(has(buildManifest({ youtube: false }))).toBe(false);
    expect(has(buildManifest({ youtube: true }))).toBe(true);
  });
});
