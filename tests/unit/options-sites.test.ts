import { describe, expect, it } from "vitest";
import { createModeMemory } from "../../src/popup/mode-memory";
import { grantedSites, revokeSiteAccess } from "../../src/platform/site-access";

describe("per-site mode list", () => {
  it("lists remembered modes by host and forgets one", async () => {
    const data: Record<string, unknown> = {};
    const mem = createModeMemory({ get: async (k) => (k in data ? { [k]: data[k] } : {}), set: async (o) => void Object.assign(data, o) });
    await mem.set("https://a.example/x", "gif");
    await mem.set("https://b.example/y", "screenshot");
    expect(await mem.all()).toEqual({ "a.example": "gif", "b.example": "screenshot" });
    await mem.remove("a.example");
    expect(await mem.all()).toEqual({ "b.example": "screenshot" });
    expect(await mem.get("https://a.example/x")).toBe("video");
  });
});

describe("site access list", () => {
  const manifestOrigins = ["https://*.reddit.com/*"];
  const deps = (granted: string[]) => {
    const removed: string[][] = [];
    return {
      removed,
      permissions: {
        getAll: async () => ({ origins: [...manifestOrigins, ...granted] }),
        remove: async (p: { origins: string[] }) => (removed.push(p.origins), true),
      },
    };
  };

  it("lists only sites the user granted at runtime, not the built-in ones", async () => {
    const d = deps(["https://video.example/*"]);
    expect(await grantedSites(d, manifestOrigins)).toEqual(["https://video.example/*"]);
  });

  it("revokes one origin", async () => {
    const d = deps(["https://video.example/*"]);
    expect(await revokeSiteAccess("https://video.example/*", d)).toBe(true);
    expect(d.removed).toEqual([["https://video.example/*"]]);
  });
});
