import { describe, expect, it } from "vitest";
import { youtubeAdapter } from "../../src/adapters/youtube";
import { buildManifest } from "../../src/manifest";
import type { DetectContext } from "../../src/adapters/types";

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

describe("youtube build gating", () => {
  it("registers YouTube content scripts only in the personal manifest", () => {
    const has = (m: ReturnType<typeof buildManifest>) => JSON.stringify(m.content_scripts).includes("youtube");
    expect(has(buildManifest({ youtube: false }))).toBe(false);
    expect(has(buildManifest({ youtube: true }))).toBe(true);
  });
});
