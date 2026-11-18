// @vitest-environment jsdom
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOptions, type OptionsDeps } from "../../src/options/app";
import { DEFAULT_SETTINGS, migrateSettings, type Settings } from "../../src/core/settings";
import { DEFAULT_SNAP_OPTIONS, type SnapOptions } from "../../src/core/snap";
import type { HistoryEntry } from "../../src/background/download";
import type { StoppedRow } from "../../src/options/data";

let root: HTMLElement;
let settings: Settings;
let snap: SnapOptions;
let history: HistoryEntry[];
let stopped: StoppedRow[];
let modes: Record<string, string>;
let sites: string[];
let calls: Record<string, unknown[]>;

const call = (name: string, ...args: unknown[]) => (calls[name] ??= []).push(args);

function make(over: Partial<OptionsDeps> = {}) {
  const deps: OptionsDeps = {
    settings: {
      get: async () => settings,
      set: async (patch) => ((settings = migrateSettings({ ...settings, ...patch })), call("settings", patch), settings),
    },
    snapPrefs: { get: async () => snap, set: async (o) => ((snap = o), void call("snap", o)) },
    data: {
      history: async () => history,
      stopped: async () => stopped,
      discard: async (id) => {
        call("discard", id);
        stopped = stopped.filter((r) => r.id !== id);
      },
      clearAll: async () => {
        call("clearAll");
        history = [];
        stopped = [];
      },
      undo: async () => void call("undo"),
    },
    modes: {
      all: async () => modes,
      remove: async (host) => {
        call("forgetMode", host);
        delete modes[host];
      },
    },
    sites: {
      list: async () => sites,
      revoke: async (o) => {
        call("revoke", o);
        sites = sites.filter((x) => x !== o);
        return true;
      },
    },
    now: () => new Date(2026, 0, 5),
    openUrl: (u) => void call("open", u),
    showDownload: (id) => void call("show", id),
    applyTheme: (t) => void call("theme", t),
    ...over,
  };
  return createOptions(root, deps);
}

const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
const byText = (sel: string, text: string) => [...root.querySelectorAll<HTMLElement>(sel)].find((e) => e.textContent?.includes(text));
const byLabel = (label: string) => root.querySelector<HTMLElement>(`[aria-label="${label}"]`);
const change = (el: HTMLSelectElement | HTMLInputElement, v: string) => {
  el.value = v;
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
};
async function axeViolations() {
  const res = await axe.run(root, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
  return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`);
}

const entry = (n: number): HistoryEntry => ({ id: `h${n}`, kind: "download", title: `Clip ${n}`, site: "reddit", pageUrl: `https://example.com/${n}`, filename: `clip-${n}.mp4`, bytes: 5 * 1024 * 1024, downloadId: 40 + n, finishedAt: n });

beforeEach(() => {
  document.body.innerHTML = `<main id="app"></main>`;
  root = document.getElementById("app")!;
  settings = { ...DEFAULT_SETTINGS, acknowledged: true };
  snap = { ...DEFAULT_SNAP_OPTIONS };
  history = [];
  stopped = [];
  modes = {};
  sites = [];
  calls = {};
});

describe("first run", () => {
  it("shows the use notice and privacy summary until acknowledged", async () => {
    settings = { ...DEFAULT_SETTINGS };
    await make();
    const notice = q(".first-run")!;
    expect(notice.textContent).toContain("Only save content you have the right to use.");
    expect(notice.textContent).toContain("7 days");
    expect(notice.textContent).toMatch(/no analytics|nothing is uploaded/i);
    byText("button", "Got it")!.click();
    await vi.waitFor(() => expect(settings.acknowledged).toBe(true));
    expect(q(".first-run")).toBeNull();
  });

  it("is not shown once acknowledged", async () => {
    await make();
    expect(q(".first-run")).toBeNull();
  });
});

describe("settings", () => {
  it("saves default format, quality and audio", async () => {
    await make();
    change(q<HTMLSelectElement>("select[name=format]")!, "webm");
    await vi.waitFor(() => expect(settings.defaultFormat).toBe("webm"));
    change(q<HTMLSelectElement>("select[name=quality]")!, "h720");
    await vi.waitFor(() => expect(settings.defaultQuality).toBe("h720"));
    byText('[role="radio"]', "Remove")!.click();
    await vi.waitFor(() => expect(settings).toMatchObject({ defaultFormat: "webm", defaultQuality: "h720", defaultAudio: "remove" }));
  });

  it("saves the file name template and shows a live example from buildFilename", async () => {
    await make();
    const input = q<HTMLInputElement>("input[name=template]")!;
    expect(q(".filename-example")!.textContent).toBe("Example: Big Buck Bunny-reddit-1080p.mp4");
    change(input, "{date}_{title}");
    expect(q(".filename-example")!.textContent).toBe("Example: 2026-01-05_Big Buck Bunny.mp4");
    await vi.waitFor(() => expect(settings.filenameTemplate).toBe("{date}_{title}"));
  });

  it("saves image format, quality, clipboard and the on-video button", async () => {
    await make();
    change(q<HTMLSelectElement>("select[name=snap-format]")!, "jpeg");
    await vi.waitFor(() => expect(q("input[name=snap-quality]")).not.toBeNull());
    change(q<HTMLInputElement>("input[name=snap-quality]")!, "60");
    q('[data-key="snap-copy"]')!.click();
    await vi.waitFor(() => expect(q('[data-key="snap-copy"]')!.getAttribute("aria-checked")).toBe("true"));
    q('[data-key="snap-button"]')!.click();
    await vi.waitFor(() => expect(snap).toEqual({ format: "jpeg", quality: 0.6, copy: true, showButton: false }));
  });

  it("saves GIF defaults", async () => {
    await make();
    change(q<HTMLSelectElement>("select[name=gif-fps]")!, "24");
    await vi.waitFor(() => expect(settings.gif.fps).toBe(24));
    change(q<HTMLSelectElement>("select[name=gif-width]")!, "original");
    await vi.waitFor(() => expect(settings.gif.width).toBe("original"));
    q('[data-key="gif-dither"]')!.click();
    await vi.waitFor(() => expect(settings.gif).toEqual({ fps: 24, width: "original", loop: 0, dither: false }));
  });

  it("applies and saves the theme", async () => {
    await make();
    byText('[role="radio"]', "Dark")!.click();
    await vi.waitFor(() => expect(settings.theme).toBe("dark"));
    expect(calls.theme!.at(-1)).toEqual(["dark"]);
  });

  it("links to the Chrome shortcuts page", async () => {
    await make();
    byText("button", "Change keyboard shortcuts")!.click();
    expect(calls.open).toContainEqual(["chrome://extensions/shortcuts"]);
  });

  it("round-trips: a new page load reads back what was saved", async () => {
    await make();
    change(q<HTMLSelectElement>("select[name=format]")!, "mkv");
    await vi.waitFor(() => expect(settings.defaultFormat).toBe("mkv"));
    document.body.innerHTML = `<main id="app"></main>`;
    root = document.getElementById("app")!;
    await make();
    expect(q<HTMLSelectElement>("select[name=format]")!.value).toBe("mkv");
  });
});

describe("sites", () => {
  it("lists granted sites with revoke and remembered modes with forget", async () => {
    sites = ["https://video.example/*"];
    modes = { "video.example": "gif" };
    await make();
    expect(q(".sites")!.textContent).toContain("video.example");
    byLabel("Revoke access to video.example")?.click();
    await vi.waitFor(() => expect(calls.revoke).toEqual([["https://video.example/*"]]));
    await vi.waitFor(() => expect(q(".sites")!.textContent).not.toContain("https://video.example"));
    byLabel("Forget mode for video.example")?.click();
    await vi.waitFor(() => expect(calls.forgetMode).toEqual([["video.example"]]));
  });
});

describe("history", () => {
  it("lists finished jobs with Re-download and Show in folder", async () => {
    history = [entry(2), entry(1)];
    await make();
    expect(root.querySelectorAll(".history li")).toHaveLength(2);
    expect(root.querySelector(".history li")!.textContent).toContain("Clip 2");
    expect(root.querySelector(".history li")!.textContent).toContain("5.0 MB");
    byLabel("Re-download Clip 2")!.click();
    expect(calls.open).toContainEqual(["https://example.com/2"]);
    byLabel("Show Clip 2 in folder")!.click();
    expect(calls.show).toContainEqual([42]);
  });

  it("hides Show in folder when the download id is unknown", async () => {
    history = [{ ...entry(1), downloadId: undefined }];
    await make();
    expect(byLabel("Show Clip 1 in folder")).toBeNull();
  });

  it("shows an empty message", async () => {
    await make();
    expect(q(".history")!.textContent).toContain("No downloads yet");
  });
});

describe("stopped downloads", () => {
  const row: StoppedRow = { id: "j1", title: "Cat clip", percent: 62, bytes: 12 * 1024 * 1024, pageUrl: "https://example.com/cat" };

  it("sits above the history with percent and partial size, Resume and Discard", async () => {
    stopped = [row];
    history = [entry(1)];
    await make();
    const stoppedEl = q(".stopped")!;
    expect(stoppedEl.textContent).toContain("Stopped at 62 %");
    expect(stoppedEl.textContent).toContain("12.0 MB");
    expect(stoppedEl.compareDocumentPosition(q(".history")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    byLabel("Resume Cat clip")!.click();
    expect(calls.open).toContainEqual(["https://example.com/cat"]);
    byLabel("Discard Cat clip")!.click();
    await vi.waitFor(() => expect(calls.discard).toEqual([["j1"]]));
    await vi.waitFor(() => expect(q(".stopped")).toBeNull());
  });
});

describe("clear all", () => {
  it("clears with an Undo toast", async () => {
    history = [entry(1)];
    stopped = [{ id: "j1", title: "Cat", percent: 10, bytes: 1, pageUrl: "https://x/" }];
    await make();
    byText("button", "Clear all")!.click();
    await vi.waitFor(() => expect(calls.clearAll).toHaveLength(1));
    await vi.waitFor(() => expect(q(".history")!.textContent).toContain("No downloads yet"));
    byText("button", "Undo")!.click();
    await vi.waitFor(() => expect(calls.undo).toHaveLength(1));
  });
});

describe("accessibility", () => {
  it("has no axe violations with every section populated", async () => {
    settings = { ...DEFAULT_SETTINGS };
    history = [entry(1)];
    stopped = [{ id: "j1", title: "Cat", percent: 10, bytes: 1, pageUrl: "https://x/" }];
    sites = ["https://video.example/*"];
    modes = { "video.example": "gif" };
    await make();
    expect(await axeViolations()).toEqual([]);
  });
});
