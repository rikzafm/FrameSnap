import { describe, expect, it, vi } from "vitest";
import { createEngineLink } from "../../src/background/engine-link";
import { createHistoryStore } from "../../src/background/history";
import type { HistoryEntry } from "../../src/background/download";
import { memoryArea } from "../helpers/orchestrator-harness";

describe("engine link", () => {
  it("creates the offscreen document, waits for it to connect, then delivers", async () => {
    const ensure = vi.fn(async () => undefined);
    const link = createEngineLink({ ensure });
    const posted: unknown[] = [];
    const sent = link.send({ t: "engine/cancel", jobId: "j" });
    await Promise.resolve();
    expect(posted).toEqual([]); // nothing connected yet
    link.attach({ postMessage: (m) => void posted.push(m) });
    await sent;
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([{ t: "engine/cancel", jobId: "j" }]);
  });

  it("sends straight away when connected, and fails when nothing connects in time", async () => {
    const link = createEngineLink({ ensure: async () => undefined, timeoutMs: 20 });
    const port = { postMessage: vi.fn() };
    link.attach(port);
    await link.send({ t: "engine/storage" });
    expect(port.postMessage).toHaveBeenCalledOnce();
    link.detach(port);
    await expect(link.send({ t: "engine/storage" })).rejects.toThrow();
  });
});

describe("history store", () => {
  const entry = (id: string): HistoryEntry => ({ id, kind: "download", title: id, site: "generic", pageUrl: "https://p.test/", filename: `${id}.mp4`, finishedAt: 1 });

  it("keeps newest first, de-duplicates by id and caps the list", async () => {
    const store = createHistoryStore(memoryArea());
    await Promise.all([store.add(entry("a")), store.add(entry("b")), store.add(entry("a"))]);
    expect((await store.list()).map((e) => e.id)).toEqual(["a", "b"]);
    for (let i = 0; i < 250; i++) await store.add(entry(`x${i}`));
    expect((await store.list()).length).toBe(200);
  });
});
