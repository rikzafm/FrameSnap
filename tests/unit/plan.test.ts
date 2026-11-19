import { describe, expect, it } from "vitest";
import { bestVariantFor, planDownload, CHUNKED_MIN_BYTES } from "../../src/core/plan";
import { buildDownloadArgs, buildGifArgs, gifLoopFlag } from "../../src/core/ffmpeg-args";
import type { DownloadOptions, Variant, VideoSource } from "../../src/core/model";
import { FrameSnapError } from "../../src/core/errors";

const MB = 1024 * 1024;

function src(variants: Partial<Variant>[], extra: Partial<VideoSource> = {}): VideoSource {
  return {
    id: "s",
    site: "generic",
    title: "t",
    pageUrl: "https://p.test/",
    duration: 60,
    variants: variants.map((v, i) => ({ id: `v${i}`, kind: "progressive", url: `https://c.test/${i}.mp4`, container: "mp4", hasAudio: true, ...v })),
    audioTracks: [],
    protection: "none",
    detectedBy: ["dom"],
    ...extra,
  };
}

const opts = (o: Partial<DownloadOptions> = {}): DownloadOptions => ({ format: "mp4", quality: "best", audio: "keep", filenameTemplate: "{title}", ...o });

describe("planDownload", () => {
  it("small progressive MP4 → direct, no engine, not resumable", () => {
    const p = planDownload(src([{ videoCodec: "avc1", audioCodec: "mp4a.40.2", sizeBytes: 10 * MB, acceptsRanges: true }]), opts());
    expect(p).toMatchObject({ route: "direct", needsEngine: false, resumable: false, notResumableReason: "direct", video: "copy", audio: "copy" });
  });

  it("large progressive with Range support → chunked and resumable", () => {
    const p = planDownload(src([{ sizeBytes: CHUNKED_MIN_BYTES, acceptsRanges: true }]), opts());
    expect(p).toMatchObject({ route: "chunked", needsEngine: false, resumable: true });
  });

  it("throttled progressive → chunked even when small", () => {
    const muxed = { videoCodec: "avc1", audioCodec: "mp4a.40.2", sizeBytes: 10 * MB, acceptsRanges: true };
    expect(planDownload(src([{ ...muxed, throttled: true }]), opts()).route).toBe("chunked");
    expect(planDownload(src([muxed]), opts()).route).toBe("direct");
  });

  it("large progressive without Range support → direct", () => {
    expect(planDownload(src([{ sizeBytes: 900 * MB }]), opts()).route).toBe("direct");
  });

  it("MP4 → MKV is a stream-copy remux", () => {
    const p = planDownload(src([{ videoCodec: "avc1.64001f", audioCodec: "mp4a.40.2" }]), opts({ format: "mkv" }));
    expect(p).toMatchObject({ route: "chunked", needsEngine: true, video: "copy", audio: "copy" });
  });

  it("MP4 → WEBM transcodes both streams", () => {
    const p = planDownload(src([{ videoCodec: "avc1", audioCodec: "mp4a.40.2" }]), opts({ format: "webm" }));
    expect(p).toMatchObject({ video: "encode", audio: "encode" });
  });

  it("video-only rendition + separate audio track → mux two inputs (Reddit DASH)", () => {
    const s = src([{ kind: "dash", hasAudio: false, height: 720, videoCodec: "avc1" }], {
      audioTracks: [
        { id: "a64", kind: "dash", url: "https://c.test/a64", codec: "mp4a.40.2", bitrate: 64_000 },
        { id: "a128", kind: "dash", url: "https://c.test/a128", codec: "mp4a.40.2", bitrate: 128_000 },
      ],
    });
    const p = planDownload(s, opts());
    expect(p.route).toBe("segments");
    expect(p.inputs.map((i) => [i.role, i.refId])).toEqual([
      ["video", "v0"],
      ["audio", "a128"],
    ]);
    expect(buildDownloadArgs(p, [{ file: "v.mp4", container: "mp4" }, { file: "a.mp4", container: "mp4" }], "out.mp4")).toEqual([
      "-hide_banner", "-nostdin", "-i", "v.mp4", "-i", "a.mp4", "-map", "0:v:0", "-map", "1:a:0?", "-c:v", "copy", "-c:a", "copy", "-movflags", "+faststart", "-f", "mp4", "-y", "out.mp4",
    ]);
  });

  it("remove audio drops the stream and needs the engine", () => {
    const p = planDownload(src([{ videoCodec: "avc1" }]), opts({ audio: "remove" }));
    expect(p).toMatchObject({ needsEngine: true, audio: "drop", video: "copy" });
  });

  it("audio only picks the smallest muxed rendition and encodes MP3", () => {
    const p = planDownload(src([{ height: 1080, bitrate: 5e6, audioCodec: "mp4a.40.2" }, { height: 360, bitrate: 6e5, audioCodec: "mp4a.40.2" }]), opts({ format: "mp3", audio: "only" }));
    expect(p.inputs[0]!.refId).toBe("v1");
    expect(p).toMatchObject({ video: "drop", audio: "encode", output: { extension: "mp3" } });
  });

  it("'Audio only' with a video format becomes M4A, copying AAC", () => {
    const p = planDownload(src([{ audioCodec: "mp4a.40.2" }]), opts({ audio: "only" }));
    expect(p).toMatchObject({ output: { format: "m4a" }, audio: "copy" });
  });

  it("HLS TS → MP4 with trim uses copy, bitstream filter and zero-based timestamps", () => {
    const p = planDownload(src([{ kind: "hls", container: "ts", videoCodec: "avc1", audioCodec: "mp4a.40.2" }]), opts({ trim: { start: 10, end: 15 } }));
    expect(p).toMatchObject({ route: "segments", video: "copy", resumable: true });
    const args = buildDownloadArgs(p, [{ file: "in.ts", container: "ts" }], "o.mp4", [{ start: 1.5, length: 5 }]);
    expect(args.slice(2, 8)).toEqual(["-ss", "1.500", "-t", "5.000", "-i", "in.ts"]);
    expect(args).toContain("aac_adtstoasc");
    expect(args).toContain("make_zero");
  });

  it("frame-accurate trim re-encodes", () => {
    const p = planDownload(src([{ videoCodec: "avc1", audioCodec: "mp4a.40.2" }]), opts({ trim: { start: 1, end: 2 }, frameAccurate: true }));
    expect(p).toMatchObject({ video: "encode", audio: "encode" });
  });

  it("live streams are not resumable", () => {
    expect(planDownload(src([{ kind: "hls", live: true }]), opts())).toMatchObject({ resumable: false, notResumableReason: "live" });
  });

  it("refuses DRM", () => {
    expect(() => planDownload(src([{}], { protection: "drm" }), opts())).toThrow(FrameSnapError);
  });

  it("warns on large files and engine limits", () => {
    const p = planDownload(src([{ sizeBytes: 1800 * MB, videoCodec: "avc1" }]), opts({ format: "webm" }));
    expect(p.warnings).toEqual(expect.arrayContaining(["large-file", "too-large"]));
  });

  it("notes when codecs were assumed from the container", () => {
    expect(planDownload(src([{}]), opts()).warnings).toContain("assumed-codecs");
  });
});

describe("best available, per output format", () => {
  // YouTube-style: every height in several codecs, VP9 with the highest bitrate
  const yt = src([
    { id: "vp9-1080", videoCodec: "vp09.00.40.08", container: "webm", height: 1080, bitrate: 3_000_000 },
    { id: "h264-1080", videoCodec: "avc1.640028", height: 1080, bitrate: 2_500_000 },
    { id: "av1-1080", videoCodec: "av01.0.08M.08", height: 1080, bitrate: 2_000_000 },
    { id: "vp9-2160", videoCodec: "vp09.00.50.08", container: "webm", height: 2160, bitrate: 15_000_000 },
  ]);
  const id = (format: DownloadOptions["format"]) => bestVariantFor(yt.variants, format)?.id;

  it("takes the tallest variant that copies into the format, preferring H.264 for MP4", () => {
    expect(id("mp4")).toBe("h264-1080");
    expect(id("mov")).toBe("h264-1080");
    expect(id("webm")).toBe("vp9-2160");
    expect(id("mkv")).toBe("vp9-2160");
  });

  it("goes taller for a codec that still copies (AV1 into MP4) over a shorter H.264", () => {
    const withAv1 = [...yt.variants, { ...yt.variants[2]!, id: "av1-2160", height: 2160 }];
    expect(bestVariantFor(withAv1, "mp4")?.id).toBe("av1-2160");
  });

  it("falls back to the plain best when nothing fits, and for audio formats", () => {
    const vp9Only = yt.variants.filter((v) => v.id.startsWith("vp9"));
    expect(bestVariantFor(vp9Only, "mp4")?.id).toBe("vp9-2160");
    expect(id("m4a")).toBe("vp9-2160");
  });

  it("plans MP4 'best' as a copy of the H.264 rendition", () => {
    const p = planDownload(yt, opts({ audio: "remove" }));
    expect(p.inputs[0]!.refId).toBe("h264-1080");
    expect(p.video).toBe("copy");
  });
});

describe("GIF args", () => {
  it("builds the two-pass palette pipeline", () => {
    const g = buildGifArgs({ trim: { start: 3, end: 8 }, fps: 15, width: 480, loop: 0, dither: true }, "in.mp4", "o.gif", { width: 1920, height: 1080 }, { start: 3, length: 5 });
    expect(g.pass1.join(" ")).toContain("fps=15,scale=480:-2:flags=lanczos,palettegen=stats_mode=diff");
    expect(g.pass2.join(" ")).toContain("paletteuse=dither=sierra2_4a");
    expect(g.pass2.slice(-4)).toEqual(["-loop", "0", "-y", "o.gif"]);
  });
  it("maps play counts to ffmpeg -loop", () => {
    expect([0, 1, 2, 3].map(gifLoopFlag)).toEqual([0, -1, 1, 2]);
  });
});
