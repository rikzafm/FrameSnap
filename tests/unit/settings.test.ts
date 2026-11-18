import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SETTINGS_VERSION, migrateSettings } from "../../src/core/settings";

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

  it("does not share mutable state with the defaults", () => {
    const a = migrateSettings(undefined);
    a.theme = "dark";
    expect(DEFAULT_SETTINGS.theme).toBe("system");
  });
});
