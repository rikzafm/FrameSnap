// @vitest-environment jsdom
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPopup, type PopupDeps } from "../../src/popup/app";
import type { VideoSource } from "../../src/core/model";

function source(id: string, over: Partial<VideoSource> = {}): VideoSource {
  return {
    id,
    site: "reddit",
    title: `Clip ${id}`,
    pageUrl: "https://example.com/p",
    duration: 60,
    variants: [{ id: `${id}-1080`, kind: "progressive", url: "https://c/1080.mp4", container: "mp4", videoCodec: "avc1.64001f", audioCodec: "mp4a.40.2", width: 1920, height: 1080, hasAudio: true }],
    audioTracks: [],
    protection: "none",
    detectedBy: ["dom"],
    dom: { visibleRatio: 1, rectWidth: 640, rectHeight: 360, playing: false, currentTime: 12 },
    ...over,
  };
}

let root: HTMLElement;
let posted: any[];

function make(sources: VideoSource[], over: Partial<PopupDeps> = {}) {
  const popup = createPopup(root, {
    tab: { id: 5, url: "https://example.com/p" },
    post: (m) => posted.push(m),
    requestAccess: vi.fn(async () => "granted") as unknown as PopupDeps["requestAccess"],
    now: () => new Date(2026, 0, 5),
    defaults: { format: "mp4", filenameTemplate: "{title}" },
    mode: "gif",
    onModeChange: () => {},
    ...over,
  });
  popup.handle({ t: "media/updated", tabId: 5, sources });
  return popup;
}
const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
const byText = (sel: string, text: string) => [...root.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.trim() === text);
const keydown = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
const startH = () => q('[role="slider"][aria-label="GIF start"]')!;
const endH = () => q('[role="slider"][aria-label="GIF end"]')!;
const ready = (jobId = "j1") => ({ t: "job/event" as const, event: { t: "gif-ready" as const, jobId, url: "blob:chrome-extension://x/1", bytes: 2 * 1024 * 1024, filename: "Clip a.gif", title: "Clip a" } });

beforeEach(() => {
  document.body.innerHTML = `<main id="app"></main>`;
  root = document.getElementById("app")!;
  posted = [];
});

describe("GIF tab", () => {
  it("starts the range at the playhead, 2 s long, with two sliders", () => {
    make([source("a")]);
    expect(startH().getAttribute("aria-valuenow")).toBe("12");
    expect(endH().getAttribute("aria-valuenow")).toBe("14");
    expect(startH().getAttribute("aria-valuetext")).toBe("12.0 s");
    expect(root.textContent).toContain("2.0 s");
  });

  it("moves a handle with the arrow keys in 0.5 s steps and keeps the 30 s limit", () => {
    make([source("a")]);
    keydown(endH(), "ArrowRight");
    expect(endH().getAttribute("aria-valuenow")).toBe("14.5");
    for (let i = 0; i < 6; i++) keydown(endH(), "PageUp");
    const span = Number(endH().getAttribute("aria-valuenow")) - Number(startH().getAttribute("aria-valuenow"));
    expect(span).toBeLessThanOrEqual(30);
    keydown(startH(), "ArrowLeft");
    expect(Number(startH().getAttribute("aria-valuenow"))).toBeLessThan(Number(endH().getAttribute("aria-valuenow")));
  });

  it("keeps focus on the handle after it moves", () => {
    make([source("a")]);
    endH().focus();
    keydown(endH(), "ArrowRight");
    expect(document.activeElement).toBe(endH());
  });

  it("shows the live estimate range, and it changes with the options", () => {
    make([source("a")]);
    const before = q(".gif-estimate")!.textContent;
    expect(before).toMatch(/≈ .+–.+/);
    byText(".seg", "30")!.click();
    expect(q(".gif-estimate")!.textContent).not.toBe(before);
  });

  it("warns when the working set is too big", () => {
    make([source("a", { variants: [{ id: "4k", kind: "progressive", url: "https://c/4k.mp4", container: "mp4", width: 3840, height: 2160, hasAudio: true }] })]);
    expect(q(".warning")).toBeNull();
    byText(".seg", "Original")!.click();
    byText(".seg", "30")!.click();
    for (let i = 0; i < 4; i++) keydown(endH(), "PageUp");
    expect(q(".warning")!.textContent).toMatch(/memory/i);
  });

  it("sends job/gif with the chosen chips", () => {
    make([source("a")]);
    byText(".seg", "24")!.click();
    byText(".seg", "640")!.click();
    byText(".seg", "2")!.click();
    q<HTMLButtonElement>('[role="switch"][aria-label="Dither"]')!.click();
    byText(".btn", "Make GIF")!.click();
    expect(posted).toEqual([{ t: "job/gif", tabId: 5, sourceId: "a", options: { trim: { start: 12, end: 14 }, fps: 24, width: 640, loop: 2, dither: false } }]);
  });

  it("defaults to 15 fps, 480 px, forever, dithered", () => {
    make([source("a")]);
    byText(".btn", "Make GIF")!.click();
    expect(posted[0].options).toMatchObject({ fps: 15, width: 480, loop: 0, dither: true });
  });

  it("starts on the GIF tab with the picked video when the picker asked for it", () => {
    make([source("a"), source("b", { title: "Picked" })], { mode: "video", pick: { sourceId: "b", mode: "gif" } });
    expect(q('[role="tab"][aria-selected="true"]')!.textContent).toBe("GIF");
    expect(q(".summary")!.textContent).toContain("Picked");
    byText(".btn", "Make GIF")!.click();
    expect(posted[0]).toMatchObject({ t: "job/gif", sourceId: "b" });
  });

  it("shows the GIF job's progress and the preview with Save and Discard when it is ready", () => {
    const popup = make([source("a")]);
    byText(".btn", "Make GIF")!.click();
    popup.handle({ t: "job/event", event: { t: "queued", jobId: "j1" } });
    popup.handle({ t: "job/event", event: { t: "progress", jobId: "j1", phase: "engine", ratio: 0.5 } });
    expect(q('[role="progressbar"]')).not.toBeNull();
    popup.handle(ready());
    expect(q('[role="progressbar"]')).toBeNull();
    expect(q<HTMLImageElement>(".gif-preview-img")!.src).toBe("blob:chrome-extension://x/1");
    byText(".btn", "Save GIF")!.click();
    expect(posted.at(-1)).toEqual({ t: "job/save", jobId: "j1" });
    byText(".btn", "Discard")!.click();
    expect(posted.at(-1)).toEqual({ t: "job/cancel", jobId: "j1" });
  });

  it("offers a preview that finished while the popup was closed, in any tab", () => {
    const popup = make([source("a")], { mode: "video" });
    popup.handle(ready("old"));
    expect(q(".gif-preview")).not.toBeNull();
  });

  it("removes the preview once it is saved or discarded", () => {
    const popup = make([source("a")]);
    popup.handle(ready());
    popup.handle({ t: "job/event", event: { t: "done", jobId: "j1", downloadId: 3, filename: "Clip a.gif" } });
    expect(q(".gif-preview")).toBeNull();
    popup.handle(ready("j2"));
    popup.handle({ t: "job/event", event: { t: "cancelled", jobId: "j2" } });
    expect(q(".gif-preview")).toBeNull();
  });

  it("retries a failed GIF as a GIF", () => {
    const popup = make([source("a")]);
    byText(".btn", "Make GIF")!.click();
    popup.handle({ t: "job/event", event: { t: "queued", jobId: "j1" } });
    popup.handle({ t: "job/event", event: { t: "failed", jobId: "j1", error: { code: "network", message: "x", retryable: true }, resumable: false, keptRatio: 0 } });
    byText(".btn", "Retry")!.click();
    expect(posted.at(-1)).toMatchObject({ t: "job/gif", sourceId: "a" });
  });

  it("has no accessibility violations", async () => {
    const popup = make([source("a")]);
    popup.handle(ready());
    const res = await axe.run(root, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
  });
});
