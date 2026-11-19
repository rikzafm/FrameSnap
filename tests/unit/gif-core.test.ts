import { describe, expect, it } from "vitest";
import { clampTrim, defaultGifTrim, describeGif, dragHandle, gifSourceSize, GIF_MIN_SECONDS, GIF_TRIM_STEP, moveHandle, nearestHandle, pickGifVariant, setHandle, shiftRange } from "../../src/core/gif";
import type { GifOptions, Variant, VideoSource } from "../../src/core/model";

const v = (id: string, width?: number, over: Partial<Variant> = {}): Variant => ({
  id,
  kind: "progressive",
  url: `https://c/${id}.mp4`,
  container: "mp4",
  hasAudio: true,
  ...(width ? { width, height: Math.round((width * 9) / 16) } : {}),
  ...over,
});
const src = (variants: Variant[]): VideoSource => ({
  id: "s",
  site: "generic",
  title: "t",
  pageUrl: "https://p/",
  variants,
  audioTracks: [],
  protection: "none",
  detectedBy: ["dom"],
});
const opts = (over: Partial<GifOptions> = {}): GifOptions => ({ trim: { start: 0, end: 5 }, fps: 15, width: 480, loop: 0, dither: true, ...over });

describe("default trim", () => {
  it("starts at the current time and lasts 2 s", () => {
    expect(defaultGifTrim(12.5, 60)).toEqual({ start: 12.5, end: 14.5 });
  });
  it("slides back so a 2 s range still fits near the end", () => {
    expect(defaultGifTrim(59, 60)).toEqual({ start: 58, end: 60 });
  });
  it("uses the whole clip when it is shorter than 2 s, and 2 s when the length is unknown", () => {
    expect(defaultGifTrim(0, 1.2)).toEqual({ start: 0, end: 1.2 });
    expect(defaultGifTrim(3, undefined)).toEqual({ start: 3, end: 5 });
  });
});

describe("trim limits", () => {
  it("clamps into the clip and to 30 s", () => {
    expect(clampTrim({ start: -3, end: 100 }, 60)).toEqual({ start: 0, end: 30 });
    expect(clampTrim({ start: 50, end: 70 }, 60)).toEqual({ start: 50, end: 60 });
  });
  it("keeps a minimum length", () => {
    const t = clampTrim({ start: 10, end: 10 }, 60);
    expect(t.end - t.start).toBeCloseTo(GIF_MIN_SECONDS);
  });
  it("moves the end handle in steps and stops at the clip end", () => {
    expect(moveHandle({ start: 1, end: 3 }, "end", 1, 60)).toEqual({ start: 1, end: 3 + GIF_TRIM_STEP });
    expect(moveHandle({ start: 1, end: 59.8 }, "end", 1, 60).end).toBe(60);
  });
  it("pulls the other handle along rather than exceeding 30 s", () => {
    expect(moveHandle({ start: 10, end: 40 }, "end", 1, 60)).toEqual({ start: 10 + GIF_TRIM_STEP, end: 40 + GIF_TRIM_STEP });
  });
  it("keeps the handles apart", () => {
    const t = moveHandle({ start: 4.9, end: 5 }, "start", 1, 60);
    expect(t.end - t.start).toBeGreaterThanOrEqual(GIF_MIN_SECONDS - 1e-9);
    expect(t.start).toBeLessThan(5);
  });
});

describe("pointer drags", () => {
  it("snaps a dragged handle to 0.1 s without float noise", () => {
    expect(dragHandle({ start: 1, end: 5 }, "start", 2.3456, 60)).toEqual({ start: 2.3, end: 5 });
    expect(dragHandle({ start: 0, end: 1 }, "end", 0.30000000000000004, 60).end).toBe(0.3);
  });
  it("cannot drag a handle past the other one or out of the clip", () => {
    expect(dragHandle({ start: 1, end: 5 }, "start", 9, 60).start).toBeCloseTo(5 - GIF_MIN_SECONDS);
    // stops at the clip end and pulls the start along to stay within 30 s
    expect(dragHandle({ start: 1, end: 5 }, "end", 99, 60)).toEqual({ start: 30, end: 60 });
  });
  it("grabs the nearer handle, the end on a tie", () => {
    expect(nearestHandle({ start: 2, end: 6 }, 3)).toBe("start");
    expect(nearestHandle({ start: 2, end: 6 }, 5)).toBe("end");
    expect(nearestHandle({ start: 4, end: 4 }, 4)).toBe("end");
  });
  it("slides the range keeping its length, inside the clip", () => {
    expect(shiftRange({ start: 2, end: 4 }, 1.04, 60)).toEqual({ start: 3, end: 5 });
    expect(shiftRange({ start: 2, end: 4 }, -10, 60)).toEqual({ start: 0, end: 2 });
    expect(shiftRange({ start: 50, end: 55 }, 10, 60)).toEqual({ start: 55, end: 60 });
  });
  it("sets a handle to an exact time for Shift+arrow nudges", () => {
    expect(setHandle({ start: 1, end: 5 }, "end", 5.1, 60)).toEqual({ start: 1, end: 5.1 });
  });
});

describe("source picking", () => {
  it("fetches the smallest rendition that is still as wide as the GIF", () => {
    expect(pickGifVariant(src([v("a", 1920), v("b", 640), v("c", 426)]), 480).id).toBe("b");
  });
  it("takes the widest when none is wide enough, and the best for Original", () => {
    expect(pickGifVariant(src([v("a", 320), v("b", 426)]), 640).id).toBe("b");
    expect(pickGifVariant(src([v("a", 1920), v("b", 640)]), "original").id).toBe("a");
  });
  it("falls back to the ranking when widths are unknown", () => {
    expect(pickGifVariant(src([v("a")]), 480).id).toBe("a");
  });
  it("assumes 16:9 for a missing height and 1280 wide for a missing width", () => {
    expect(gifSourceSize(v("a", 1920))).toEqual({ width: 1920, height: 1080 });
    expect(gifSourceSize(v("a", undefined, { height: 720 }))).toEqual({ width: 1280, height: 720 });
    expect(gifSourceSize(v("a"))).toEqual({ width: 1280, height: 720 });
  });
});

describe("describeGif", () => {
  it("gives a size range", () => {
    const d = describeGif(opts(), { width: 1920, height: 1080 });
    expect(d.range).toMatch(/^≈ .+–.+$/);
  });
});
