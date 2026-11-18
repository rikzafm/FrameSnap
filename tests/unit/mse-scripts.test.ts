import { describe, expect, it } from "vitest";
import { grantedOptionalOrigins, MSE_SCRIPT_ID, syncMseScripts, type MseScriptsApi } from "../../src/platform/mse-scripts";

function fakeApi(initial?: string[]) {
  let registered = initial ? [{ id: MSE_SCRIPT_ID, matches: initial }] : [];
  const calls: string[] = [];
  const api: MseScriptsApi = {
    getRegistered: async () => registered,
    register: async (s) => {
      calls.push("register");
      registered = s.map((x) => ({ id: x.id, matches: x.matches }));
      expect(s[0]).toMatchObject({ runAt: "document_start", world: "MAIN" });
    },
    update: async (s) => {
      calls.push("update");
      registered = s;
    },
    unregister: async () => {
      calls.push("unregister");
      registered = [];
    },
  };
  return { api, calls, get: () => registered[0]?.matches };
}

describe("MSE hook registration (opt-in per site)", () => {
  it("only runtime-granted origins qualify", () => {
    expect(grantedOptionalOrigins(["*://*.reddit.com/*", "https://video.test/*", "<all_urls>"], ["*://*.reddit.com/*"])).toEqual(["https://video.test/*"]);
  });

  it("registers for granted sites, updates when they change, removes when none are left", async () => {
    const f = fakeApi();
    await syncMseScripts(f.api, "mse.js", ["https://a.test/*"]);
    await syncMseScripts(f.api, "mse.js", ["https://a.test/*", "https://b.test/*"]);
    expect(f.get()).toEqual(["https://a.test/*", "https://b.test/*"]);
    await syncMseScripts(f.api, "mse.js", []);
    expect(f.calls).toEqual(["register", "update", "unregister"]);
    expect(f.get()).toBeUndefined();
  });

  it("does nothing when there is nothing to register or remove", async () => {
    const f = fakeApi();
    await syncMseScripts(f.api, "mse.js", []);
    expect(f.calls).toEqual([]);
  });
});
