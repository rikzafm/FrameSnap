import { describe, expect, it } from "vitest";
import { createSettingsStore, SETTINGS_KEY, type ChangeEvents } from "../../src/platform/settings-store";
import { DEFAULT_SETTINGS } from "../../src/core/settings";

function fake() {
  const data: Record<string, unknown> = {};
  const listeners: ((c: Record<string, { newValue?: unknown }>, area: string) => void)[] = [];
  const area = {
    async get(key: string) {
      return key in data ? { [key]: data[key] } : {};
    },
    async set(items: Record<string, unknown>) {
      const changes: Record<string, { newValue?: unknown }> = {};
      for (const [k, v] of Object.entries(items)) {
        data[k] = v;
        changes[k] = { newValue: v };
      }
      listeners.forEach((l) => l(changes, "local"));
    },
  };
  const events: ChangeEvents = { addListener: (fn) => void listeners.push(fn), removeListener: (fn) => void listeners.splice(listeners.indexOf(fn), 1) };
  return { data, area, events };
}

describe("settings store", () => {
  it("returns defaults when nothing is stored and persists patches", async () => {
    const f = fake();
    const store = createSettingsStore(f.area, f.events);
    expect(await store.get()).toEqual(DEFAULT_SETTINGS);
    const next = await store.set({ theme: "dark" });
    expect(next.theme).toBe("dark");
    expect((await store.get()).theme).toBe("dark");
    expect(f.data[SETTINGS_KEY]).toBeDefined();
  });

  it("migrates a stored legacy record on read", async () => {
    const f = fake();
    f.data[SETTINGS_KEY] = { theme: "light" };
    const store = createSettingsStore(f.area, f.events);
    expect((await store.get()).theme).toBe("light");
  });

  it("notifies subscribers of changes and stops after unsubscribe", async () => {
    const f = fake();
    const store = createSettingsStore(f.area, f.events);
    const seen: string[] = [];
    const off = store.subscribe((s) => seen.push(s.theme));
    await store.set({ theme: "dark" });
    off();
    await store.set({ theme: "light" });
    expect(seen).toEqual(["dark"]);
  });
});
