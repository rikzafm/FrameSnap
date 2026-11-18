import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobStore, type StorageAreaLike } from "../../src/background/job-store";
import { newJob, withTracks, type JobRecord } from "../../src/core/jobs/job";
import type { DownloadPlan } from "../../src/core/plan";
import type { TrackPlan } from "../../src/core/jobs/chunks";

class FakeArea implements StorageAreaLike {
  data: Record<string, unknown> = {};
  setCalls = 0;
  async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
    if (keys == null) return { ...this.data };
    const list = typeof keys === "string" ? [keys] : keys;
    return Object.fromEntries(list.filter((k) => k in this.data).map((k) => [k, structuredClone(this.data[k])]));
  }
  async set(items: Record<string, unknown>): Promise<void> {
    this.setCalls++;
    for (const [k, v] of Object.entries(items)) this.data[k] = structuredClone(v);
  }
  async remove(keys: string | string[]): Promise<void> {
    for (const k of typeof keys === "string" ? [keys] : keys) delete this.data[k];
  }
}

function job(id: string, keyCount = 200): JobRecord {
  const plan = { resumable: true } as DownloadPlan;
  const base = newJob({
    id,
    kind: "download",
    filename: "a.mp4",
    source: { pageUrl: "https://x.com/p", site: "x", sourceId: "s", title: "t", variant: { kind: "progressive", id: "v" } },
    options: { format: "mp4", quality: "best", audio: "keep", filenameTemplate: "{title}" },
    plan,
    now: 1,
  });
  const track = {
    trackId: "0",
    role: "muxed",
    container: "mp4",
    chunks: Array.from({ length: keyCount }, (_, i) => ({ key: `k${i}` })),
    totalBytes: 1,
  } as unknown as TrackPlan;
  return withTracks(base, [{ plan: track, validators: { layout: "L" } as never }], 1);
}

describe("job store", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("round-trips records and lists only job keys", async () => {
    const area = new FakeArea();
    area.data["settings"] = { a: 1 };
    const store = createJobStore({ area });
    await store.put(job("a"));
    await store.put(job("b"));
    expect((await store.get("a"))?.id).toBe("a");
    expect(await store.get("zzz")).toBeUndefined();
    expect((await store.list()).map((j) => j.id).sort()).toEqual(["a", "b"]);
    await store.remove("a");
    expect((await store.list()).map((j) => j.id)).toEqual(["b"]);
  });

  it("coalesces 100 chunk commits into at most 2 storage writes", async () => {
    const area = new FakeArea();
    const store = createJobStore({ area });
    await store.put(job("a"));
    area.setCalls = 0;
    for (let i = 0; i < 100; i++) {
      store.commitChunks("a", [{ trackId: "0", key: `k${i}` }]);
      await vi.advanceTimersByTimeAsync(5);
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(area.setCalls).toBeLessThanOrEqual(2);
    const saved = (await store.get("a"))!;
    expect(saved.tracks[0]!.committed).toHaveLength(100);
    expect(saved.progress).toBeCloseTo(0.5);
  });

  it("flush writes pending commits immediately", async () => {
    const area = new FakeArea();
    const store = createJobStore({ area });
    await store.put(job("a"));
    store.commitChunks("a", [{ trackId: "0", key: "k0" }]);
    await store.flush();
    expect((area.data["jobs/a"] as JobRecord).tracks[0]!.committed).toEqual(["k0"]);
  });

  it("put after pending commits does not lose them", async () => {
    const area = new FakeArea();
    const store = createJobStore({ area });
    await store.put(job("a"));
    store.commitChunks("a", [{ trackId: "0", key: "k0" }]);
    const cur = (await store.get("a"))!;
    await store.put({ ...cur, status: "running" });
    const saved = (await store.get("a"))!;
    expect(saved.status).toBe("running");
    expect(saved.tracks[0]!.committed).toEqual(["k0"]);
  });
});
