// @vitest-environment jsdom
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPicker } from "../../src/content/picker";
import { createDomDetector } from "../../src/content/dom-detect";
import { ERROR_COPY } from "../../src/core/errors";
import type { ContentToWorker } from "../../src/core/messages";
import type { VideoSource } from "../../src/core/model";
import { createPopup, type PopupDeps } from "../../src/popup/app";
import { gifMemoryWarning } from "../../src/popup/model";
import { fakeEmePage } from "../fixtures/fake-eme";

const MB = 1024 * 1024;
const PROTECTED = "This video is protected and cannot be saved";

let root: HTMLElement;
let posted: unknown[];
let access: ReturnType<typeof vi.fn>;

function make(over: Partial<PopupDeps> = {}) {
  return createPopup(root, {
    tab: { id: 5, url: "https://example.com/p" },
    post: (m) => posted.push(m),
    requestAccess: access as unknown as PopupDeps["requestAccess"],
    now: () => new Date(2026, 0, 5),
    defaults: { format: "mp4", filenameTemplate: "{title}" },
    mode: "video",
    onModeChange: () => {},
    ...over,
  });
}
const buttons = () => [...root.querySelectorAll<HTMLButtonElement>("button")];
const byText = (text: string) => buttons().find((b) => b.textContent?.includes(text));

function plain(id: string, over: Partial<VideoSource> = {}): VideoSource {
  return {
    id,
    site: "generic",
    title: `Video ${id}`,
    pageUrl: "https://example.com/p",
    duration: 60,
    variants: [{ id: `${id}-720`, kind: "progressive", url: "https://c/720.mp4", container: "mp4", videoCodec: "avc1.64001f", audioCodec: "mp4a.40.2", height: 720, sizeBytes: 84 * MB, hasAudio: true }],
    audioTracks: [],
    protection: "none",
    detectedBy: ["dom"],
    ...over,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  root = document.createElement("div");
  document.body.append(root);
  posted = [];
  access = vi.fn().mockResolvedValue("granted");
});

describe("DRM: fake-EME fixture", () => {
  it("shows the protected state with no enabled action", async () => {
    const eme = fakeEmePage();
    document.body.append(root);
    expect(eme.protection).toBe("drm");
    make().handle({ t: "media/updated", tabId: 5, sources: [eme] });
    expect(root.textContent).toContain(PROTECTED);
    expect(buttons().filter((b) => !b.disabled && !b.closest('[role="tablist"]'))).toEqual([]);
    expect(buttons().every((b) => b.disabled || b.getAttribute("role") === "tab")).toBe(true);
    expect(byText("Download")!.disabled).toBe(true);
    const snap = buttons().find((b) => b.getAttribute("aria-label") === "Snap frame")!;
    expect(snap.disabled).toBe(true);
    snap.click();
    byText("Download")!.click();
    expect(posted).toEqual([]);
    const res = await axe.run(root, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(res.violations).toEqual([]);
  });

  it("a protected video in a list is listed but cannot be acted on", () => {
    make().handle({ t: "media/updated", tabId: 5, sources: [plain("a", { protection: "drm" }), plain("b")] });
    expect(root.textContent).toContain(PROTECTED);
    expect(byText("Download")!.disabled).toBe(true);
    root.querySelector<HTMLElement>('[role="radio"]:not([aria-checked="true"])')!.click();
    expect(byText("Download")!.disabled).toBe(false);
    expect(root.textContent).not.toContain(PROTECTED);
  });

  it("the picker bar lists a protected video with disabled actions and the copy", () => {
    const eme = fakeEmePage();
    const sent: ContentToWorker[] = [];
    const detector = createDomDetector({ document, frameUrl: "https://example.com/watch", emit: () => {} });
    const video = document.querySelector("video")!;
    document.elementsFromPoint = () => [video];
    const picker = createPicker({ document, detector, send: (m) => sent.push(m), shadowMode: "open" });
    picker.start({});
    video.dispatchEvent(new MouseEvent("click", { clientX: 5, clientY: 5, bubbles: true, cancelable: true, composed: true }));
    const bar = document.querySelector<HTMLElement>("[data-framesnap-picker]")!.shadowRoot!;
    expect(eme.protection).toBe("drm");
    expect(bar.textContent).toContain(PROTECTED);
    const actions = [...bar.querySelectorAll<HTMLButtonElement>(".bar button")];
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((b) => b.disabled)).toBe(true);
    sent.length = 0;
    actions[0]!.click();
    expect(sent.filter((m) => m.t === "picker/action")).toEqual([]);
    picker.cancel();
  });
});

describe("error codes in the popup", () => {
  it("not-found offers Select video, which starts the picker", () => {
    const p = make();
    p.handle({ t: "media/updated", tabId: 5, sources: [plain("a")] });
    p.handle({ t: "job/event", event: { t: "queued", jobId: "j1" } } as never);
    p.handle({ t: "job/event", event: { t: "failed", jobId: "j1", error: { code: "not-found", message: "", retryable: true }, resumable: false } } as never);
    expect(root.textContent).toContain(ERROR_COPY["not-found"].message);
    posted.length = 0;
    byText("Select video")!.click();
    expect(posted).toContainEqual({ t: "picker/start", tabId: 5 });
  });

  it("permission offers Allow this site, which asks for access", async () => {
    const p = make();
    p.handle({ t: "media/updated", tabId: 5, sources: [plain("a")] });
    p.handle({ t: "job/event", event: { t: "queued", jobId: "j1" } } as never);
    p.handle({ t: "job/event", event: { t: "failed", jobId: "j1", error: { code: "permission", message: "", retryable: true }, resumable: false } } as never);
    byText("Allow this site")!.click();
    await vi.waitFor(() => expect(access).toHaveBeenCalledOnce());
  });

  it("too-large offers a lower quality, which selects the next lower choice", () => {
    const p = make();
    const s = plain("a", {
      variants: [
        { id: "hi", kind: "progressive", url: "https://c/hi.ts", container: "ts", videoCodec: "avc1.64001f", audioCodec: "mp4a.40.2", height: 1080, sizeBytes: 2000 * MB, hasAudio: true },
        { id: "lo", kind: "progressive", url: "https://c/lo.ts", container: "ts", videoCodec: "avc1.64001f", audioCodec: "mp4a.40.2", height: 480, sizeBytes: 300 * MB, hasAudio: true },
      ],
    });
    p.handle({ t: "media/updated", tabId: 5, sources: [s] });
    root.querySelector<HTMLElement>('[data-key="seg-mkv"]')!.click();
    expect(root.textContent).toContain(ERROR_COPY["too-large"].message);
    expect(byText("Download")!.disabled).toBe(true);
    byText("Choose lower quality")!.click();
    expect(root.querySelector<HTMLSelectElement>("select[name=quality]")!.value).toBe("lo");
    expect(root.textContent).not.toContain(ERROR_COPY["too-large"].message);
    expect(byText("Download")!.disabled).toBe(false);
  });

  it("a denied access request shows the permission copy as a toast with its action", async () => {
    access.mockResolvedValueOnce("denied");
    make().handle({ t: "media/updated", tabId: 5, sources: [] });
    root.querySelector<HTMLElement>('[role="switch"]')!.click();
    await vi.waitFor(() => expect(root.querySelector(".toast")?.textContent).toContain(ERROR_COPY.permission.message));
    root.querySelector<HTMLButtonElement>(".toast button")!.click();
    await vi.waitFor(() => expect(access).toHaveBeenCalledTimes(2));
  });
});

describe("warnings", () => {
  it("large files warn but stay downloadable", () => {
    const s = plain("a");
    s.variants[0]!.sizeBytes = 900 * MB;
    make().handle({ t: "media/updated", tabId: 5, sources: [s] });
    expect(root.textContent).toMatch(/large file/i);
    expect(byText("Download")!.disabled).toBe(false);
  });

  it("the GIF low-memory warning appears above 600 MB of working set", () => {
    const opts = { trim: { start: 0, end: 30 }, fps: 30, width: "original", loop: 0, dither: true } as const;
    expect(gifMemoryWarning(opts, 1920, 1080)).toMatch(/memory/i);
    expect(gifMemoryWarning({ ...opts, trim: { start: 0, end: 2 }, fps: 10, width: 320 }, 1920, 1080)).toBeUndefined();
  });
});

afterEach(() => {
  document.body.innerHTML = "";
});
