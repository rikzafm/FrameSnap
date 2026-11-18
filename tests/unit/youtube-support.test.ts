import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPlayerResponse } from "../../src/main-world/youtube-reader";
import { supportedSiteNames } from "../../src/ui/sites";
import { findYoutubeLeaks } from "../../scripts/check-store-build";

describe("youtube reader, footer and store-build check", () => {
  it("prefers the live player response over the stale global", () => {
    const doc = { querySelector: () => ({ getPlayerResponse: () => "live" }) };
    expect(readPlayerResponse({ ytInitialPlayerResponse: "stale" }, doc)).toBe("live");
    expect(readPlayerResponse({ ytInitialPlayerResponse: "stale" }, { querySelector: () => null })).toBe("stale");
  });

  it("names YouTube in the footer only in the personal build", () => {
    expect(supportedSiteNames().includes("YouTube")).toBe(__YOUTUBE__);
    expect(supportedSiteNames()).toContain("Reddit");
  });

  it("the build check finds YouTube strings in a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "fs-check-"));
    writeFileSync(join(dir, "a.js"), "console.log('ok')");
    expect(findYoutubeLeaks(dir)).toEqual([]);
    writeFileSync(join(dir, "b.js"), "x='https://rr1.googlevideo.com'");
    expect(findYoutubeLeaks(dir)).toHaveLength(1);
  });
});
