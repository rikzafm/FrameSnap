import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_VERSION, migrateSettings, resolveDefaultQuality } from "../../src/core/settings";
import type { VideoSource } from "../../src/core/model";

describe("resolveDefaultQuality", () => {
  const src = { variants: [{ id: "a", height: 1080 }, { id: "b", height: 720 }, { id: "c", height: 360 }, { id: "d" }] } as unknown as VideoSource;

  it("keeps best, and turns a height cap into the tallest variant at or under it", () => {
    expect(resolveDefaultQuality(src, "best")).toBe("best");
    expect(resolveDefaultQuality(src, "h720")).toBe("b");
    expect(resolveDefaultQuality(src, "h500")).toBe("c");
  });

  it("caps a portrait clip by its short side", () => {
    const tall = { variants: [{ id: "0", width: 1080, height: 1920 }, { id: "1", width: 720, height: 1280 }] } as unknown as VideoSource;
    expect(resolveDefaultQuality(tall, "h720")).toBe("1");
  });

  it("falls back to best when nothing fits or the value is unknown", () => {
    expect(resolveDefaultQuality(src, "h240")).toBe("best");
    expect(resolveDefaultQuality(src, "zzz")).toBe("best");
  });
});

describe("migrateSettings", () => {
  it("returns defaults from empty or garbage input", () => {
    for (const raw of [undefined, null, {}, "x", 42, []]) {
      expect(migrateSettings(raw)).toEqual(DEFAULT_SETTINGS);
    }
    expect(DEFAULT_SETTINGS.version).toBe(SETTINGS_VERSION);
    expect(DEFAULT_SETTINGS.theme).toBe("system");
  });

  it("keeps valid stored values and drops invalid ones", () => {
    const out = migrateSettings({ version: SETTINGS_VERSION, theme: "dark", defaultFormat: "nope", filenameTemplate: "{title}" });
    expect(out.theme).toBe("dark");
    expect(out.defaultFormat).toBe(DEFAULT_SETTINGS.defaultFormat);
    expect(out.filenameTemplate).toBe("{title}");
  });

  it("upgrades an unversioned record and stamps the current version", () => {
    const out = migrateSettings({ theme: "light" });
    expect(out.theme).toBe("light");
    expect(out.version).toBe(SETTINGS_VERSION);
  });

  it("defaults: best quality, keep audio, unacknowledged, 15 fps / 480 px / looping GIFs", () => {
    expect(DEFAULT_SETTINGS.defaultQuality).toBe("best");
    expect(DEFAULT_SETTINGS.defaultAudio).toBe("keep");
    expect(DEFAULT_SETTINGS.acknowledged).toBe(false);
    expect(DEFAULT_SETTINGS.gif).toEqual({ fps: 15, width: 480, loop: 0, dither: true });
  });

  it("round-trips the options-page fields", () => {
    const stored = { defaultQuality: "720", defaultAudio: "remove", acknowledged: true, gif: { fps: 24, width: "original", loop: 3, dither: false } };
    const out = migrateSettings(stored);
    expect(out.defaultQuality).toBe("720");
    expect(out.defaultAudio).toBe("remove");
    expect(out.acknowledged).toBe(true);
    expect(out.gif).toEqual(stored.gif);
  });

  it("drops invalid options-page fields one by one", () => {
    const out = migrateSettings({ defaultQuality: "", defaultAudio: "loud", acknowledged: "yes", gif: { fps: 7, width: 100, loop: -2, dither: "no" } });
    expect(out.defaultQuality).toBe("best");
    expect(out.defaultAudio).toBe("keep");
    expect(out.acknowledged).toBe(false);
    expect(out.gif).toEqual(DEFAULT_SETTINGS.gif);
  });

  it("does not share mutable state with the defaults", () => {
    const a = migrateSettings(undefined);
    a.theme = "dark";
    expect(DEFAULT_SETTINGS.theme).toBe("system");
  });
});
