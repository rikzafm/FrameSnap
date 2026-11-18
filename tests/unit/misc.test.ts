import { describe, expect, it } from "vitest";
import { buildFilename, renderTemplate, sanitizeSegment, formatTimecode } from "../../src/core/filename";
import { mergeAll, rankSources, bestVariant } from "../../src/core/rank";
import { estimateGifBytes, estimateDownloadBytes, gifDimensions } from "../../src/core/estimate";
import { canonicalPageUrl, matchSource, matchVariant, sameMedia, type SourceRef } from "../../src/core/jobs/source-ref";
import { selectEvictions, storeCap, MAX_AGE_MS } from "../../src/core/jobs/cleanup";
import { planByteChunks, fetchProgress, layoutHash, planDashChunks } from "../../src/core/jobs/chunks";
import { probeFromHeaders } from "../../src/core/jobs/tracks";
import { isPopupToWorker } from "../../src/core/messages";
import type { JobRecord } from "../../src/core/jobs/job";
import type { VideoSource } from "../../src/core/model";

const d = new Date(2026, 10, 18);

describe("filenames", () => {
  it("renders tokens and collapses empty ones", () => {
    expect(renderTemplate("{title}-{site}-{resolution}", { title: "Clip", site: "reddit", date: d })).toBe("Clip-reddit");
    expect(buildFilename("{title} {date} {time}", { title: "a", site: "x", date: d, time: 75.5 }, ".PNG")).toBe("a 2026-11-18 01-15.500.png");
  });
  it("sanitises unsafe names", () => {
    expect(sanitizeSegment('a<b>:"c"/d\\e|f?g*h')).toBe("a b c d e f g h");
    expect(sanitizeSegment("CON")).toBe("_CON");
    expect(sanitizeSegment("...")).toBe("video");
    expect(sanitizeSegment("🔥 fire 🔥.")).toBe("fire");
    expect(sanitizeSegment("x".repeat(400))).toHaveLength(150);
  });
  it("formats timecodes", () => {
    expect(formatTimecode(3725)).toBe("1-02-05");
  });
});

function vs(id: string, o: Partial<VideoSource> = {}): VideoSource {
  return { id, site: "generic", title: id, pageUrl: "https://p.test/", variants: [], audioTracks: [], protection: "none", detectedBy: ["dom"], ...o };
}

describe("ranking and merge", () => {
  it("prefers big, visible, playing videos", () => {
    const ranked = rankSources([
      vs("small", { dom: { visibleRatio: 1, rectWidth: 200, rectHeight: 100, playing: true } }),
      vs("big", { dom: { visibleRatio: 1, rectWidth: 800, rectHeight: 450, playing: false } }),
      vs("offscreen", { dom: { visibleRatio: 0, rectWidth: 1920, rectHeight: 1080, playing: false } }),
      vs("drm", { protection: "drm", dom: { visibleRatio: 1, rectWidth: 1920, rectHeight: 1080, playing: true } }),
    ]);
    expect(ranked.map((s) => s.id)).toEqual(["big", "small", "offscreen", "drm"]);
  });

  it("folds a sniffed URL into the adapter's canonical entry", () => {
    const url = "https://c.test/a.m3u8";
    const net = vs("net:123", { detectedBy: ["network"], variants: [{ id: "n", kind: "hls", url, container: "ts", hasAudio: true }] });
    const adapter = vs("x:42", { title: "Tweet", detectedBy: ["adapter"], variants: [{ id: "a", kind: "hls", url, container: "ts", hasAudio: true, height: 720 }] });
    const merged = mergeAll([net], [adapter]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "x:42", title: "Tweet", detectedBy: ["network", "adapter"] });
    expect(merged[0]!.variants[0]!.height).toBe(720);
  });

  it("picks the best variant by height then bitrate", () => {
    expect(bestVariant([{ id: "a", kind: "progressive", url: "a", container: "mp4", hasAudio: true, height: 720, bitrate: 1 }, { id: "b", kind: "progressive", url: "b", container: "mp4", hasAudio: true, height: 720, bitrate: 2 }])?.id).toBe("b");
  });
});

describe("estimates", () => {
  it("scales Content-Length by the trim", () => {
    expect(estimateDownloadBytes({ id: "v", kind: "progressive", url: "", container: "mp4", hasAudio: true, sizeBytes: 1000 }, undefined, 10, { start: 0, end: 5 })).toEqual({ bytes: 500, confidence: "approx" });
  });
  it("GIF dimensions keep aspect with even height", () => {
    expect(gifDimensions({ trim: { start: 0, end: 1 }, fps: 10, width: 480, loop: 0, dither: false }, 1920, 1080)).toEqual({ width: 480, height: 270 });
    const e = estimateGifBytes({ trim: { start: 0, end: 5 }, fps: 15, width: 480, loop: 0, dither: true }, 1920, 1080);
    expect(e.low).toBeLessThan(e.high);
  });
});

describe("source matching", () => {
  it("canonicalises page URLs across hosts and tracking params", () => {
    expect(canonicalPageUrl("https://twitter.com/a/status/1?s=20&t=abc#x")).toBe("https://x.com/a/status/1");
    expect(canonicalPageUrl("https://old.reddit.com/r/v/comments/1/x/?utm_source=share&sort=top")).toBe("https://reddit.com/r/v/comments/1/x?sort=top");
  });

  const ref: SourceRef = { pageUrl: "https://x.com/a", site: "x", sourceId: "x:1", title: "t", duration: 30, variant: { kind: "progressive", height: 720, bitrate: 2_000_000, codec: "avc1", id: "old" } };

  it("matches the same rendition within 10 % bitrate", () => {
    const v = (id: string, bitrate: number, height = 720) => ({ id, kind: "progressive" as const, url: id, container: "mp4" as const, hasAudio: true, height, bitrate, videoCodec: "avc1.64" });
    expect(matchVariant(ref.variant, [v("far", 2_500_000), v("near", 2_100_000), v("sd", 2_000_000, 480)])?.id).toBe("near");
    expect(matchVariant(ref.variant, [v("far", 2_500_000)])).toBeUndefined();
  });

  it("falls back to a unique same-length video, else ambiguous", () => {
    const v = { id: "x", kind: "progressive" as const, url: "u", container: "mp4" as const, hasAudio: true, height: 720, bitrate: 2_000_000 };
    expect(matchSource(ref, [vs("other", { site: "x", duration: 30.2, variants: [v] })]).status).toBe("found");
    expect(matchSource(ref, [vs("a", { site: "x", duration: 30, variants: [v] }), vs("b", { site: "x", duration: 30, variants: [v] })]).status).toBe("ambiguous");
  });

  it("compares validators", () => {
    expect(sameMedia({ etag: 'W/"1"', layout: "h" }, { etag: '"1"', layout: "h" })).toBe(true);
    expect(sameMedia({ etag: '"1"', layout: "h" }, { etag: '"2"', layout: "h" })).toBe(false);
    expect(sameMedia({ layout: "h", contentLength: 5 }, { layout: "h", contentLength: 6 })).toBe(false);
  });
});

describe("chunks", () => {
  it("splits files into stable byte-range keys", () => {
    expect(planByteChunks("u", 20, 8).map((c) => c.key)).toEqual(["r0-7", "r8-15", "r16-19"]);
    expect(layoutHash(planByteChunks("https://a?sig=1", 20, 8))).toBe(layoutHash(planByteChunks("https://b?sig=2", 20, 8)));
  });
  it("chunks a DASH whole file only when ranges work", () => {
    const whole = [{ key: "whole", url: "u", start: 0, duration: 1 }];
    expect(planDashChunks({}, whole, { totalBytes: 20 * 1024 * 1024, acceptsRanges: true })).toHaveLength(3);
    expect(planDashChunks({}, whole, { acceptsRanges: false }).map((c) => c.key)).toEqual(["whole"]);
  });
  it("reports progress by bytes", () => {
    const t = { trackId: "0", role: "muxed" as const, container: "mp4" as const, chunks: planByteChunks("u", 30, 10) };
    expect(fetchProgress([t], new Map([["0", new Set(["r0-9"])]]))).toBeCloseTo(1 / 3);
  });
  it("reads probe headers", () => {
    expect(probeFromHeaders(206, new Headers({ "Content-Range": "bytes 0-0/12345", ETag: '"e"' }))).toEqual({ totalBytes: 12345, acceptsRanges: true, etag: '"e"', lastModified: undefined });
  });
});

describe("cleanup", () => {
  const rec = (id: string, status: JobRecord["status"], updatedAt: number, resumable = true) => ({ id, status, updatedAt, resumable }) as JobRecord;
  it("evicts finished, orphaned, expired, then oldest failed over the cap", () => {
    const now = MAX_AGE_MS * 2;
    const stored = ["done", "orphan", "old", "f1", "f2", "run"].map((jobId, i) => ({ jobId, bytes: 100, updatedAt: i }));
    const records = [rec("done", "done", now), rec("old", "failed", 0), rec("f1", "failed", now - 10), rec("f2", "failed", now - 5), rec("run", "running", 1)];
    expect(selectEvictions(stored, records, now, 150).sort()).toEqual(["done", "f1", "f2", "old", "orphan"]);
    expect(selectEvictions(stored, records, now, 250).sort()).toEqual(["done", "f1", "old", "orphan"]);
  });
  it("caps the store at half the quota, max 4 GB", () => {
    expect(storeCap(2e9)).toBe(1e9);
    expect(storeCap(1e12)).toBe(4 * 1024 ** 3);
  });
});

describe("message guards", () => {
  it("accepts well-formed and rejects malformed messages", () => {
    expect(isPopupToWorker({ t: "job/resume", jobId: "j", tabId: 3 })).toBe(true);
    expect(isPopupToWorker({ t: "job/resume", jobId: "", tabId: 3 })).toBe(false);
    expect(isPopupToWorker({ t: "nope" })).toBe(false);
    expect(isPopupToWorker(null)).toBe(false);
  });
});
