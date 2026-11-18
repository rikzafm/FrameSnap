import { describe, expect, it } from "vitest";
import { createOptionsData, HISTORY_SHOWN, type OptionsArea } from "../../src/options/data";
import { MemoryChunkStore } from "../../src/core/jobs/store";
import type { HistoryEntry } from "../../src/background/download";

function memoryArea(initial: Record<string, unknown> = {}): OptionsArea & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (keys === null) return { ...data };
      return key(keys, data);
    },
    async set(items) {
      Object.assign(data, items);
    },
    async remove(keys) {
      for (const k of keys) delete data[k];
    },
  };
}
const key = (k: string, data: Record<string, unknown>) => (k in data ? { [k]: data[k] } : {});

const entry = (n: number): HistoryEntry => ({ id: `h${n}`, kind: "download", title: `Clip ${n}`, site: "x", pageUrl: `https://x.com/${n}`, filename: `clip-${n}.mp4`, finishedAt: n });

function job(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    kind: "download",
    status: "failed",
    phase: "fetch",
    createdAt: 1,
    updatedAt: 2,
    filename: `${id}.mp4`,
    source: { pageUrl: `https://x.com/${id}`, site: "x", sourceId: "s", title: `Job ${id}`, variant: { kind: "hls", id: "v" } },
    options: {},
    plan: {},
    tracks: [],
    progress: 0.62,
    attempts: 1,
    resumable: true,
    ...over,
  };
}

async function setup(opts: { history?: HistoryEntry[]; jobs?: ReturnType<typeof job>[]; chunkJobs?: string[] } = {}) {
  const area = memoryArea({ history: opts.history ?? [] });
  for (const j of opts.jobs ?? []) area.data[`jobs/${j.id}`] = j;
  const chunks = new MemoryChunkStore();
  for (const id of opts.chunkJobs ?? []) await chunks.write(id, "t", "0", new Uint8Array(1000));
  const timers: (() => void)[] = [];
  const data = createOptionsData({ area, chunks, schedule: (fn) => (timers.push(fn), timers.length), cancelSchedule: (t) => void (timers[Number(t) - 1] = () => undefined) });
  return { area, chunks, data, fire: () => timers.splice(0).forEach((f) => f()) };
}

describe("options data: history", () => {
  it("shows only the last 20 finished jobs, newest first", async () => {
    const all = Array.from({ length: 30 }, (_, i) => entry(30 - i)); // stored newest first
    const { data } = await setup({ history: all });
    const shown = await data.history();
    expect(shown).toHaveLength(HISTORY_SHOWN);
    expect(shown[0]!.id).toBe("h30");
    expect(shown[19]!.id).toBe("h11");
  });
});

describe("options data: stopped jobs", () => {
  it("lists failed resumable jobs with percent and partial-data size from the chunk store", async () => {
    const { data } = await setup({ jobs: [job("a"), job("b", { status: "done" }), job("c", { resumable: false }), job("d", { updatedAt: 9, progress: 0.1 })], chunkJobs: ["a", "d"] });
    const rows = await data.stopped();
    expect(rows.map((r) => r.id)).toEqual(["d", "a"]);
    expect(rows[1]).toMatchObject({ id: "a", title: "Job a", percent: 62, bytes: 1000, pageUrl: "https://x.com/a" });
  });

  it("discard removes the record and its chunks", async () => {
    const { data, area, chunks } = await setup({ jobs: [job("a")], chunkJobs: ["a"] });
    await data.discard("a");
    expect(area.data["jobs/a"]).toBeUndefined();
    expect(await chunks.jobs()).toEqual([]);
  });
});

describe("options data: clear all", () => {
  it("empties history, job records and the chunk store once the undo window passes", async () => {
    const { data, area, chunks, fire } = await setup({ history: [entry(1)], jobs: [job("a"), job("b", { status: "done" })], chunkJobs: ["a", "orphan"] });
    await data.clearAll();
    expect(await data.history()).toEqual([]);
    expect(Object.keys(area.data).filter((k) => k.startsWith("jobs/"))).toEqual([]);
    fire();
    await data.settled();
    expect(await chunks.jobs()).toEqual([]);
  });

  it("undo restores history and job records and keeps the chunks", async () => {
    const { data, area, chunks, fire } = await setup({ history: [entry(1)], jobs: [job("a")], chunkJobs: ["a"] });
    await data.clearAll();
    await data.undo();
    fire();
    await data.settled();
    expect((await data.history()).map((e) => e.id)).toEqual(["h1"]);
    expect(area.data["jobs/a"]).toBeDefined();
    expect((await chunks.jobs()).map((j) => j.jobId)).toEqual(["a"]);
  });

  it("leaves running jobs and their chunks alone", async () => {
    const { data, area, chunks, fire } = await setup({ jobs: [job("run", { status: "running" })], chunkJobs: ["run"] });
    await data.clearAll();
    fire();
    await data.settled();
    expect(area.data["jobs/run"]).toBeDefined();
    expect((await chunks.jobs()).map((j) => j.jobId)).toEqual(["run"]);
  });

  it("a second clear flushes the first so nothing is left behind", async () => {
    const { data, chunks } = await setup({ chunkJobs: ["a"] });
    await data.clearAll();
    await data.clearAll();
    await data.settled();
    expect(await chunks.jobs()).toEqual([]);
  });
});
