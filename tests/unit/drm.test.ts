import { describe, expect, it } from "vitest";
import { isKnownDrmHost } from "../../src/core/drm";
import { mergeAll } from "../../src/core/rank";
import type { VideoSource } from "../../src/core/model";

const src = (id: string, pageUrl: string, over: Partial<VideoSource> = {}): VideoSource => ({
  id,
  site: "generic",
  title: "t",
  pageUrl,
  variants: [{ id: `${id}-v`, kind: "progressive", url: `https://cdn.test/${id}.mp4`, container: "mp4", hasAudio: true }],
  audioTracks: [],
  protection: "none",
  detectedBy: ["dom"],
  ...over,
});

describe("known DRM hosts", () => {
  it.each([
    "https://www.netflix.com/watch/1",
    "https://www.disneyplus.com/video/x",
    "https://www.primevideo.com/detail/1",
    "https://www.amazon.com/gp/video/detail/B0",
    "https://play.max.com/x",
    "https://www.hulu.com/watch/1",
    "https://tv.apple.com/show/x",
    "https://open.spotify.com/episode/1",
  ])("flags %s", (url) => expect(isKnownDrmHost(url)).toBe(true));

  it.each(["https://example.com/", "https://notnetflix.com/", "https://netflix.com.evil.test/", "not a url"])("does not flag %s", (url) =>
    expect(isKnownDrmHost(url)).toBe(false),
  );

  it("merging marks a source from a known DRM host as protected even without other signals", () => {
    const [s] = mergeAll([], [src("a", "https://www.netflix.com/watch/1")]);
    expect(s!.protection).toBe("drm");
  });

  it("DOM, manifest and host signals are merged: any one marks the source protected", () => {
    const existing = mergeAll([], [src("a", "https://example.com/p", { protection: "drm" })]);
    const [s] = mergeAll(existing, [src("a", "https://example.com/p")]);
    expect(s!.protection).toBe("drm");
    const [plain] = mergeAll([], [src("b", "https://example.com/p")]);
    expect(plain!.protection).toBe("none");
  });
});
