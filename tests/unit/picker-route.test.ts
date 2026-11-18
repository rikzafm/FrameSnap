import { describe, expect, it, vi } from "vitest";
import { routeContentMessage, routePopupMessage } from "../../src/background/router";
import type { SourceRef } from "../../src/core/jobs/source-ref";
import type { VideoSource } from "../../src/core/model";

const source = (over: Partial<VideoSource> = {}): VideoSource => ({
  id: "dom:1",
  site: "generic",
  title: "t",
  pageUrl: "https://page.test/",
  variants: [],
  audioTracks: [],
  frameRef: { frameId: 0, elementKey: "e1" },
  protection: "none",
  detectedBy: ["dom"],
  ...over,
});

const ref = (duration?: number): SourceRef => ({
  pageUrl: "https://page.test/",
  site: "generic",
  sourceId: "dom:1",
  title: "My clip",
  duration,
  variant: { kind: "progressive", id: "p" },
});

describe("picker routing", () => {
  it("popup picker/start tells the tab's frames to pick, naming the job being resumed", async () => {
    const sent: unknown[] = [];
    await routePopupMessage(
      { t: "picker/start", tabId: 4, resumeJobId: "j1" },
      { sendToTab: async (id, m) => void sent.push([id, m]), resumeRef: async () => ref() },
    );
    expect(sent).toEqual([[4, { t: "picker/start", resumeJobId: "j1", resumeTitle: "My clip" }]]);
  });

  it("stamps the picked source with the sender frame id", async () => {
    const onPicked = vi.fn();
    await routeContentMessage({ t: "picker/picked", source: source() }, { tabId: 4, frameId: 9 }, { onPicked });
    expect(onPicked).toHaveBeenCalledWith(4, expect.objectContaining({ frameRef: { frameId: 9, elementKey: "e1" } }));
  });

  it("resume pick is checked with acceptsPicked and passed back with its job id", async () => {
    const resumePicked = vi.fn();
    const deps = { resumeRef: async () => ref(100), resumePicked };
    const ok = await routeContentMessage(
      { t: "picker/picked", source: source({ duration: 100.3 }), resumeJobId: "j1" },
      { tabId: 4, frameId: 0 },
      deps,
    );
    expect(ok).toEqual({ accepted: true });
    expect(resumePicked).toHaveBeenCalledWith("j1", 4, expect.objectContaining({ id: "dom:1" }));

    resumePicked.mockClear();
    const bad = await routeContentMessage(
      { t: "picker/picked", source: source({ duration: 500 }), resumeJobId: "j1" },
      { tabId: 4, frameId: 0 },
      deps,
    );
    expect(bad).toEqual({ accepted: false });
    expect(resumePicked).not.toHaveBeenCalled();
  });

  it("forwards picker actions with the stamped source", async () => {
    const onAction = vi.fn();
    await routeContentMessage({ t: "picker/action", action: "gif", source: source() }, { tabId: 4, frameId: 2 }, { onAction });
    expect(onAction).toHaveBeenCalledWith("gif", 4, expect.objectContaining({ frameRef: { frameId: 2, elementKey: "e1" } }));
  });
});
