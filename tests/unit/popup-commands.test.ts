import { describe, expect, it, vi } from "vitest";
import { createJobCommands } from "../../src/background/popup-commands";
import { FrameSnapError } from "../../src/core/errors";
import type { JobEvent, PopupToWorker } from "../../src/core/messages";

const options = { format: "mp4", quality: "best", audio: "keep", filenameTemplate: "{title}" } as const;

function setup(over: Partial<Parameters<typeof createJobCommands>[0]["orchestrator"]> = {}) {
  const events: JobEvent[] = [];
  const orchestrator = {
    download: vi.fn(async () => "j"),
    startGif: vi.fn(async () => "j"),
    saveGif: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    discard: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    ...over,
  };
  const commands = createJobCommands({ orchestrator, settings: async () => ({ filenameTemplate: "{title}-x" }), emit: (e) => events.push(e), newId: () => "fresh" });
  return { commands, orchestrator, events };
}

describe("job commands from the popup", () => {
  it("ignores messages that are not job commands", () => {
    const { commands } = setup();
    expect(commands.handle({ t: "media/list", tabId: 1 })).toBe(false);
  });

  it("dispatches each job command to the orchestrator", async () => {
    const { commands, orchestrator } = setup();
    const msgs: PopupToWorker[] = [
      { t: "job/download", tabId: 1, sourceId: "s", options },
      { t: "job/gif", tabId: 1, sourceId: "s", options: { trim: { start: 0, end: 2 }, fps: 10, width: 320, loop: 0, dither: true } },
      { t: "job/save", jobId: "a" },
      { t: "job/resume", jobId: "a", tabId: 1 },
      { t: "job/discard", jobId: "a" },
      { t: "job/cancel", jobId: "a" },
    ];
    for (const m of msgs) expect(commands.handle(m)).toBe(true);
    await commands.idle();
    expect(orchestrator.download).toHaveBeenCalledWith({ tabId: 1, sourceId: "s", options });
    expect(orchestrator.startGif).toHaveBeenCalledWith(expect.objectContaining({ tabId: 1, sourceId: "s", filenameTemplate: "{title}-x" }));
    expect(orchestrator.saveGif).toHaveBeenCalledWith("a");
    expect(orchestrator.resume).toHaveBeenCalledWith("a", 1);
    expect(orchestrator.discard).toHaveBeenCalledWith("a");
    expect(orchestrator.cancel).toHaveBeenCalledWith("a");
  });

  it("shows the user a failed job when a command throws, under the job's own id when it has one", async () => {
    const boom = async () => {
      throw new FrameSnapError("network");
    };
    const { commands, events } = setup({ download: boom, resume: boom, saveGif: boom, startGif: boom });
    commands.handle({ t: "job/download", tabId: 1, sourceId: "s", options });
    commands.handle({ t: "job/resume", jobId: "r", tabId: 1 });
    commands.handle({ t: "job/save", jobId: "g" });
    commands.handle({ t: "job/gif", tabId: 1, sourceId: "s", options: { trim: { start: 0, end: 2 }, fps: 10, width: 320, loop: 0, dither: true } });
    await commands.idle();
    expect(events.map((e) => e.jobId).sort()).toEqual(["fresh", "fresh", "g", "r"]);
    for (const e of events) expect(e).toMatchObject({ t: "failed", error: { code: "network" } });
  });
});
