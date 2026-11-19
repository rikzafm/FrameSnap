import { describe, expect, it } from "vitest";
import { readPlayerResponse } from "../../src/main-world/youtube-reader";
import { supportedSiteNames } from "../../src/ui/sites";

describe("youtube reader and footer", () => {
  it("prefers the live player response over the stale global", () => {
    const doc = { querySelector: () => ({ getPlayerResponse: () => "live" }) };
    expect(readPlayerResponse({ ytInitialPlayerResponse: "stale" }, doc)).toBe("live");
    expect(readPlayerResponse({ ytInitialPlayerResponse: "stale" }, { querySelector: () => null })).toBe("stale");
  });

  it("names YouTube in the footer", () => {
    expect(supportedSiteNames()).toContain("YouTube");
    expect(supportedSiteNames()).toContain("Reddit");
  });
});
