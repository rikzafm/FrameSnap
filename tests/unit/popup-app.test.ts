// @vitest-environment jsdom
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPopup, type PopupDeps } from "../../src/popup/app";
import { createModeMemory } from "../../src/popup/mode-memory";
import { appError } from "../../src/core/errors";
import type { JobRecord } from "../../src/core/jobs/job";
import type { VideoSource } from "../../src/core/model";

const MB = 1024 * 1024;
function source(id: string, title: string): VideoSource {
  return {
    id,
    site: "reddit",
    title,
    pageUrl: "https://example.com/p",
    duration: 60,
    variants: [
      { id: `${id}-720`, kind: "progressive", url: "https://c/720.mp4", container: "mp4", videoCodec: "avc1.64001f", audioCodec: "mp4a.40.2", height: 720, sizeBytes: 84 * MB, hasAudio: true },
    ],
    audioTracks: [],
    protection: "none",
    detectedBy: ["dom"],
  };
}

let root: HTMLElement;
let posted: unknown[];
let access: ReturnType<typeof vi.fn>;
let modes: string[];

function make(over: Partial<PopupDeps> = {}) {
  const popup = createPopup(root, {
    tab: { id: 5, url: "https://example.com/p" },
    post: (m) => posted.push(m),
    requestAccess: access as unknown as PopupDeps["requestAccess"],
    now: () => new Date(2026, 0, 5),
    defaults: { format: "mp4", filenameTemplate: "{title}-{site}-{resolution}" },
    mode: "video",
    onModeChange: (m) => modes.push(m),
    ...over,
  });
  return popup;
}
const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
const byText = (sel: string, text: string) => [...root.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(text));
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

async function axeViolations() {
  const res = await axe.run(root, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
  return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`);
}

beforeEach(() => {
  document.body.innerHTML = `<main id="app"></main>`;
  root = document.getElementById("app")!;
  posted = [];
  modes = [];
  access = vi.fn(async () => "granted");
});
afterEach(() => {
  document.body.innerHTML = "";
});

describe("empty state", () => {
  it("shows three steps, a Remember switch and Start picking", async () => {
    make().handle({ t: "media/updated", tabId: 5, sources: [] });
    expect(root.querySelectorAll("ol li")).toHaveLength(3);
    const sw = q('[role="switch"]')!;
    expect(sw.getAttribute("aria-checked")).toBe("false");
    byText("button", "Start picking")!.click();
    expect(posted).toContainEqual({ t: "picker/start", tabId: 5 });
    expect(await axeViolations()).toEqual([]);
  });

  it("asks for site access from the Remember click and reflects the result", async () => {
    make().handle({ t: "media/updated", tabId: 5, sources: [] });
    q('[role="switch"]')!.click();
    await vi.waitFor(() => expect(q('[role="switch"]')!.getAttribute("aria-checked")).toBe("true"));
    expect(access).toHaveBeenCalledOnce();
  });

  it("stays off when access is denied", async () => {
    access.mockResolvedValue("denied");
    make().handle({ t: "media/updated", tabId: 5, sources: [] });
    q('[role="switch"]')!.click();
    await vi.waitFor(() => expect(access).toHaveBeenCalled());
    expect(q('[role="switch"]')!.getAttribute("aria-checked")).toBe("false");
  });
});

describe("single video", () => {
  it("shows the summary card, tabs, option rows and the file name preview", async () => {
    make().handle({ t: "media/updated", tabId: 5, sources: [source("a", "Cat clip")] });
    expect(q(".summary")!.textContent).toContain("Cat clip");
    expect([...root.querySelectorAll('[role="tab"]')].map((t) => t.textContent)).toEqual(["Video", "GIF", "Screenshot"]);
    for (const label of ["Format", "Quality", "Audio", "Trim", "File name"]) expect(byText("label, .row-label", label)).toBeTruthy();
    expect(q(".filename-preview")!.textContent).toBe("Cat clip-reddit-720p.mp4");
    expect(q(".estimate")!.textContent).toBe("84 MB");
    expect(await axeViolations()).toEqual([]);
  });

  it("downloads with the chosen options", () => {
    make().handle({ t: "media/updated", tabId: 5, sources: [source("a", "Cat clip")] });
    const fmt = q<HTMLSelectElement>("select[name=format]")!;
    fmt.value = "webm";
    fmt.dispatchEvent(new Event("change", { bubbles: true }));
    byText("button", "Download")!.click();
    expect(posted).toContainEqual({
      t: "job/download",
      tabId: 5,
      sourceId: "a",
      options: { format: "webm", quality: "best", audio: "keep", filenameTemplate: "{title}-{site}-{resolution}" },
    });
  });

  it("snaps a frame", () => {
    make().handle({ t: "media/updated", tabId: 5, sources: [source("a", "Cat clip")] });
    byText("button", "Snap")!.click();
    expect(posted).toContainEqual({ t: "snap/frame", tabId: 5, sourceId: "a" });
  });

  it("moves between tabs with arrow keys and remembers the mode; GIF and Screenshot are empty shells", () => {
    make().handle({ t: "media/updated", tabId: 5, sources: [source("a", "Cat clip")] });
    const video = q('[role="tab"][aria-selected="true"]')!;
    key(video, "ArrowRight");
    expect(modes).toEqual(["gif"]);
    expect(q('[role="tabpanel"]')!.id).toBeTruthy();
    expect(q(".estimate")).toBeNull();
  });

  it("warns on large files", () => {
    const s = source("a", "Big");
    s.variants[0]!.sizeBytes = 900 * MB;
    make().handle({ t: "media/updated", tabId: 5, sources: [s] });
    expect(q('[role="alert"], .warning')!.textContent).toMatch(/large file/i);
  });

  it("shows the protection copy for DRM and disables Download", () => {
    const s = source("a", "Locked");
    s.protection = "drm";
    make().handle({ t: "media/updated", tabId: 5, sources: [s] });
    expect(root.textContent).toContain("protected");
    expect(byText("button", "Download")!.hasAttribute("disabled")).toBe(true);
  });
});

describe("list", () => {
  it("lists videos as radio cards and selects with the keyboard", async () => {
    make().handle({ t: "media/updated", tabId: 5, sources: [source("a", "First"), source("b", "Second")] });
    expect(root.textContent).toContain("2 videos found");
    expect(root.querySelectorAll('[role="radio"]')).toHaveLength(2);
    expect(await axeViolations()).toEqual([]);
    const first = q('[role="radio"][aria-checked="true"]')!;
    key(first, "ArrowDown");
    expect(q('[role="radio"][aria-checked="true"]')!.textContent).toContain("Second");
    byText("button", "Download")!.click();
    expect(posted.at(-1)).toMatchObject({ t: "job/download", sourceId: "b" });
  });

  it("starts the picker from Not listed?", () => {
    make().handle({ t: "media/updated", tabId: 5, sources: [source("a", "First"), source("b", "Second")] });
    byText("button", "Not listed?")!.click();
    expect(posted).toContainEqual({ t: "picker/start", tabId: 5 });
  });

  it("honours the worker's selected id", () => {
    make().handle({ t: "media/updated", tabId: 5, sources: [source("a", "First"), source("b", "Second")], selectedId: "b" });
    expect(q('[role="radio"][aria-checked="true"]')!.textContent).toContain("Second");
  });
});

describe("jobs", () => {
  it("shows progress with Cancel, then a failed job with Resume and kept percent", async () => {
    const popup = make();
    popup.handle({ t: "media/updated", tabId: 5, sources: [source("a", "Cat clip")] });
    byText("button", "Download")!.click();
    popup.handle({ t: "job/event", event: { t: "queued", jobId: "j1" } });
    popup.handle({ t: "job/event", event: { t: "progress", jobId: "j1", phase: "fetch", ratio: 0.4 } });
    const row = q(".job")!;
    expect(row.textContent).toContain("Cat clip");
    expect(row.textContent).toContain("Downloading");
    expect(row.textContent).toContain("40 %");
    expect(q('[role="progressbar"]')!.getAttribute("aria-valuenow")).toBe("40");
    expect(await axeViolations()).toEqual([]);
    byText("button", "Cancel")!.click();
    expect(posted).toContainEqual({ t: "job/cancel", jobId: "j1" });

    popup.handle({ t: "job/event", event: { t: "failed", jobId: "j1", error: appError("network"), resumable: true, keptRatio: 0.62 } });
    expect(q(".job")!.textContent).toContain("The connection dropped");
    byText("button", "Resume (62 % kept)")!.click();
    expect(posted).toContainEqual({ t: "job/resume", jobId: "j1", tabId: 5 });
  });
});

describe("resume banner", () => {
  const rec = (id: string, title: string, progress: number) =>
    ({ id, status: "failed", resumable: true, progress, updatedAt: 1, source: { pageUrl: "https://example.com/p", title } }) as unknown as JobRecord;

  it("offers Resume and Discard for a single job", () => {
    const popup = make();
    popup.handle({ t: "media/updated", tabId: 5, sources: [source("a", "Cat clip")] });
    popup.setResumable([rec("j9", "Cat clip", 0.62)]);
    expect(q(".banner")!.textContent).toContain("Download stopped at 62 %: Cat clip");
    byText(".banner button", "Resume")!.click();
    expect(posted).toContainEqual({ t: "job/resume", jobId: "j9", tabId: 5 });
    popup.setResumable([rec("j9", "Cat clip", 0.62)]);
    byText(".banner button", "Discard")!.click();
    expect(posted).toContainEqual({ t: "job/discard", jobId: "j9" });
    expect(q(".banner")).toBeNull();
  });

  it("collapses several jobs and expands on click", async () => {
    const popup = make();
    popup.handle({ t: "media/updated", tabId: 5, sources: [source("a", "Cat clip")] });
    popup.setResumable([rec("j1", "One", 0.1), rec("j2", "Two", 0.5)]);
    const toggle = byText(".banner button", "2 downloads can be resumed")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.click();
    expect(q(".banner")!.textContent).toContain("Two");
    expect(await axeViolations()).toEqual([]);
  });

  it("is hidden when nothing can be resumed", () => {
    const popup = make();
    popup.handle({ t: "media/updated", tabId: 5, sources: [] });
    popup.setResumable([]);
    expect(q(".banner")).toBeNull();
  });
});

describe("screenshot tab", () => {
  const open = (over: Partial<PopupDeps> = {}) => {
    const popup = make({ mode: "screenshot", ...over });
    popup.handle({ t: "media/updated", tabId: 5, sources: [source("a", "Cat clip")] });
    return popup;
  };

  it("snaps with the chosen format and quality, and remembers them", () => {
    const saved: unknown[] = [];
    open({ snap: { options: { format: "png", quality: 0.92, copy: false, showButton: true }, onChange: (o) => saved.push(o) } });
    expect(q("input[name=snap-quality]")).toBeNull(); // PNG has no quality
    const fmt = q<HTMLSelectElement>("select[name=snap-format]")!;
    fmt.value = "jpeg";
    fmt.dispatchEvent(new Event("change", { bubbles: true }));
    const quality = q<HTMLInputElement>("input[name=snap-quality]")!;
    quality.value = "60";
    quality.dispatchEvent(new Event("input", { bubbles: true }));
    byText("button", "Snap frame")!.click();
    expect(posted).toContainEqual({ t: "snap/frame", tabId: 5, sourceId: "a", options: { format: "jpeg", quality: 0.6, copy: false, showButton: true } });
    expect(saved.at(-1)).toMatchObject({ format: "jpeg", quality: 0.6 });
  });

  it("toggles clipboard copy and the on-video button", () => {
    const saved: { copy: boolean; showButton: boolean }[] = [];
    open({ snap: { options: { format: "png", quality: 0.92, copy: false, showButton: true }, onChange: (o) => saved.push(o) } });
    q('[role="switch"][data-key="snap-copy"]')!.click();
    expect(saved.at(-1)!.copy).toBe(true);
    q('[role="switch"][data-key="snap-button"]')!.click();
    expect(saved.at(-1)!.showButton).toBe(false);
  });

  it("steps one frame back and forward", () => {
    open();
    byText("button", "◀")!.click();
    byText("button", "▶")!.click();
    expect(posted).toContainEqual({ t: "snap/step", tabId: 5, dir: -1, sourceId: "a" });
    expect(posted).toContainEqual({ t: "snap/step", tabId: 5, dir: 1, sourceId: "a" });
    expect(byText("button", "◀")!.getAttribute("aria-label")).toBe("Previous frame");
    expect(byText("button", "▶")!.getAttribute("aria-label")).toBe("Next frame");
  });

  it("starts and stops a burst every N seconds", () => {
    open();
    const every = q<HTMLInputElement>("input[name=burst-every]")!;
    every.value = "5";
    every.dispatchEvent(new Event("input", { bubbles: true }));
    byText("button", "Start burst")!.click();
    expect(posted).toContainEqual(expect.objectContaining({ t: "snap/burst", tabId: 5, sourceId: "a", intervalSec: 5 }));
    byText("button", "Stop burst")!.click();
    expect(posted).toContainEqual({ t: "snap/burst-stop", tabId: 5 });
    expect(root.textContent).toContain("200");
  });

  it("has no accessibility violations", async () => {
    open();
    expect(await axeViolations()).toEqual([]);
  });
});

describe("mode memory", () => {
  it("remembers the mode per site", async () => {
    const data: Record<string, unknown> = {};
    const mem = createModeMemory({ get: async (k) => (k in data ? { [k]: data[k] } : {}), set: async (o) => void Object.assign(data, o) });
    expect(await mem.get("https://example.com/a")).toBe("video");
    await mem.set("https://example.com/a", "gif");
    expect(await mem.get("https://example.com/other")).toBe("gif");
    expect(await mem.get("https://other.org/")).toBe("video");
  });
});
