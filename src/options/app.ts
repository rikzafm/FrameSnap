/**
 * Options page: defaults, sites, history and the first-run notice. State is
 * loaded once, then the whole (small) tree re-renders after each change and
 * focus is restored by `data-key`. Storage and browser APIs come in as deps.
 */
import type { HistoryEntry } from "../background/download";
import { buildFilename } from "../core/filename";
import type { AudioMode, OutputFormat } from "../core/model";
import type { Settings, Theme } from "../core/settings";
import type { SnapFormat, SnapOptions } from "../core/snap";
import { button, h, nextId, segmented, selectRow, switchControl, toast } from "../ui/components";
import { supportedSiteNames } from "../ui/sites";
import type { StoppedRow } from "./data";

export interface OptionsDeps {
  settings: { get(): Promise<Settings>; set(patch: Partial<Settings>): Promise<Settings> };
  snapPrefs: { get(): Promise<SnapOptions>; set(o: SnapOptions): Promise<void> };
  data: {
    history(): Promise<HistoryEntry[]>;
    stopped(): Promise<StoppedRow[]>;
    discard(jobId: string): Promise<void>;
    clearAll(): Promise<void>;
    undo(): Promise<void>;
  };
  modes: { all(): Promise<Record<string, string>>; remove(host: string): Promise<void> };
  sites: { list(): Promise<string[]>; revoke(origin: string): Promise<boolean> };
  now(): Date;
  openUrl(url: string): void;
  showDownload(id: number): void;
  applyTheme(theme: Theme): void;
}

export const SHORTCUTS_URL = "chrome://extensions/shortcuts";

const FORMATS: OutputFormat[] = ["mp4", "webm", "mkv", "mov", "mp3", "m4a"];
const QUALITIES = [
  { value: "best", label: "Best available" },
  { value: "h1080", label: "Up to 1080p" },
  { value: "h720", label: "Up to 720p" },
  { value: "h480", label: "Up to 480p" },
  { value: "h360", label: "Up to 360p" },
];
const AUDIO = [
  { value: "keep", label: "Keep" },
  { value: "remove", label: "Remove" },
  { value: "only", label: "Audio only" },
];
const THEMES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

const originLabel = (origin: string) => origin.replace(/^[a-z]+:\/\//i, "").replace(/\/\*$/, "");

export async function createOptions(root: HTMLElement, deps: OptionsDeps) {
  const s = {
    settings: await deps.settings.get(),
    snap: await deps.snapPrefs.get(),
    history: await deps.data.history(),
    stopped: await deps.data.stopped(),
    sites: await deps.sites.list(),
    modes: await deps.modes.all(),
    toast: undefined as { text: string; undo?: boolean } | undefined,
  };
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  deps.applyTheme(s.settings.theme);

  async function save(patch: Partial<Settings>, focusKey?: string) {
    s.settings = await deps.settings.set(patch);
    if (patch.theme) deps.applyTheme(s.settings.theme);
    render(focusKey);
  }
  async function saveSnap(patch: Partial<SnapOptions>, rerender = true, focusKey?: string) {
    s.snap = { ...s.snap, ...patch };
    await deps.snapPrefs.set(s.snap);
    if (rerender) render(focusKey);
  }
  async function reloadLists() {
    [s.history, s.stopped, s.sites, s.modes] = await Promise.all([deps.data.history(), deps.data.stopped(), deps.sites.list(), deps.modes.all()]);
  }
  function showToast(text: string, undo = false) {
    s.toast = { text, undo };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ((s.toast = undefined), render()), 8000);
  }

  const row = (label: string, control: Node, forId?: string) => h("div", { class: "row" }, forId ? h("label", { class: "row-label", for: forId }, label) : h("span", { class: "row-label" }, label), h("div", { class: "row-control" }, control));
  function section(title: string, cls: string, ...kids: (Node | false | undefined)[]): HTMLElement {
    const id = nextId("sec");
    return h("section", { class: `group ${cls}`, "aria-labelledby": id }, h("h2", { class: "section-title", id }, title), ...kids.filter((k): k is Node => !!k));
  }

  function firstRun(): HTMLElement | undefined {
    if (s.settings.acknowledged) return undefined;
    return h(
      "section",
      { class: "first-run", "aria-label": "Welcome" },
      h(
        "ul",
        { class: "privacy" },
        h("li", {}, "Nothing is uploaded and there is no analytics. Frame Snap only contacts the sites of the media you choose."),
        h("li", {}, "A download that stops keeps its partial data privately on this device for up to 7 days, so you can resume it. Discard it here at any time."),
        h("li", {}, "Settings and history stay in this browser."),
      ),
      button("Got it", () => void save({ acknowledged: true }), { variant: "primary", key: "ack" }),
    );
  }

  function defaults(): HTMLElement {
    const audioId = nextId("audio");
    const example = h("p", { class: "filename-example", "aria-live": "polite" });
    const updateExample = (template: string) => {
      const ext = s.settings.defaultFormat;
      example.textContent = `Example: ${buildFilename(template, { title: "Big Buck Bunny", site: "reddit", date: deps.now(), height: 1080 }, ext)}`;
    };
    updateExample(s.settings.filenameTemplate);
    const input = h("input", {
      id: "opt-template",
      name: "template",
      type: "text",
      value: s.settings.filenameTemplate,
      spellcheck: "false",
      "data-key": "opt-template",
      onInput: (e) => {
        const v = (e.target as HTMLInputElement).value;
        updateExample(v);
        if (v.trim() !== "") void deps.settings.set({ filenameTemplate: v }).then((n) => (s.settings = n));
      },
    });
    return section(
      "Video defaults",
      "defaults",
      selectRow("opt-format", "Format", "format", FORMATS.map((f) => ({ value: f, label: f.toUpperCase() })), s.settings.defaultFormat, (v) => void save({ defaultFormat: v as OutputFormat }, "format")),
      selectRow("opt-quality", "Quality", "quality", QUALITIES, s.settings.defaultQuality, (v) => void save({ defaultQuality: v }, "quality")),
      h("div", { class: "row" }, h("span", { class: "row-label", id: audioId }, "Audio"), segmented(audioId, AUDIO, s.settings.defaultAudio, (v) => void save({ defaultAudio: v as AudioMode }, `seg-${v}`))),
      h("div", { class: "row row-stack" }, h("label", { class: "row-label", for: "opt-template" }, "File name"), input, h("p", { class: "hint" }, "Use {title} {site} {date} {resolution} {time}."), example),
    );
  }

  function images(): HTMLElement {
    const kids: Node[] = [selectRow("opt-snap-format", "Image format", "snap-format", [{ value: "png", label: "PNG" }, { value: "jpeg", label: "JPEG" }, { value: "webp", label: "WEBP" }], s.snap.format, (v) => void saveSnap({ format: v as SnapFormat }, true, "snap-format"))];
    if (s.snap.format !== "png") {
      const out = h("output", { class: "estimate", for: "opt-snap-quality" }, `${Math.round(s.snap.quality * 100)} %`);
      kids.push(
        row(
          "Image quality",
          h(
            "span",
            { class: "range" },
            h("input", {
              id: "opt-snap-quality",
              name: "snap-quality",
              type: "range",
              min: 10,
              max: 100,
              step: 5,
              value: String(Math.round(s.snap.quality * 100)),
              "data-key": "snap-quality",
              onInput: (e) => {
                const pct = Number((e.target as HTMLInputElement).value) || 92;
                out.textContent = `${pct} %`;
                void saveSnap({ quality: pct / 100 }, false);
              },
            }),
            out,
          ),
          "opt-snap-quality",
        ),
      );
    }
    kids.push(
      row("Copy snapped frames to the clipboard", switchControl("Copy snapped frames to the clipboard", s.snap.copy, () => void saveSnap({ copy: !s.snap.copy }, true, "snap-copy"), "snap-copy")),
      row("Snap button on videos", switchControl("Snap button on videos", s.snap.showButton, () => void saveSnap({ showButton: !s.snap.showButton }, true, "snap-button"), "snap-button")),
      row("Keyboard shortcuts", button("Change keyboard shortcuts", () => deps.openUrl(SHORTCUTS_URL), { key: "shortcuts" })),
    );
    return section("Screenshots", "images", ...kids);
  }

  function gifs(): HTMLElement {
    const g = s.settings.gif;
    return section(
      "GIF defaults",
      "gifs",
      selectRow("opt-gif-fps", "Frame rate", "gif-fps", [10, 15, 24, 30].map((n) => ({ value: String(n), label: `${n} fps` })), String(g.fps), (v) => void save({ gif: { ...g, fps: Number(v) as typeof g.fps } }, "gif-fps")),
      selectRow("opt-gif-width", "Width", "gif-width", [{ value: "320", label: "320 px" }, { value: "480", label: "480 px" }, { value: "640", label: "640 px" }, { value: "original", label: "Original" }], String(g.width), (v) => void save({ gif: { ...g, width: (v === "original" ? v : Number(v)) as typeof g.width } }, "gif-width")),
      row("Loop forever", switchControl("Loop forever", g.loop === 0, () => void save({ gif: { ...g, loop: g.loop === 0 ? 1 : 0 } }, "gif-loop"), "gif-loop")),
      row("Dithering", switchControl("Dithering", g.dither, () => void save({ gif: { ...g, dither: !g.dither } }, "gif-dither"), "gif-dither")),
    );
  }

  function appearance(): HTMLElement {
    const themeId = nextId("theme");
    return section("Appearance", "appearance", h("div", { class: "row" }, h("span", { class: "row-label", id: themeId }, "Theme"), segmented(themeId, THEMES, s.settings.theme, (v) => void save({ theme: v as Theme }, `seg-${v}`))));
  }

  function sites(): HTMLElement {
    const list = h("ul", { class: "list" });
    for (const origin of s.sites) {
      const host = originLabel(origin);
      list.append(
        h(
          "li",
          { class: "list-row" },
          h("span", { class: "list-text" }, host, h("span", { class: "hint" }, " (access granted)")),
          button("Revoke", async () => (await deps.sites.revoke(origin), await reloadLists(), render()), { label: `Revoke access to ${host}`, key: `revoke-${host}` }),
        ),
      );
    }
    for (const [host, mode] of Object.entries(s.modes)) {
      list.append(
        h(
          "li",
          { class: "list-row" },
          h("span", { class: "list-text" }, host, h("span", { class: "hint" }, ` (opens on ${mode})`)),
          button("Forget", async () => (await deps.modes.remove(host), await reloadLists(), render()), { label: `Forget mode for ${host}`, key: `forget-${host}` }),
        ),
      );
    }
    return section("Sites", "sites", list.childElementCount ? list : h("p", { class: "hint" }, "No sites remembered yet. Sites you allow from the popup, and the tab each one opens on, show up here."));
  }

  function stoppedView(): HTMLElement | undefined {
    if (!s.stopped.length) return undefined;
    const list = h("ul", { class: "list" });
    for (const j of s.stopped) {
      list.append(
        h(
          "li",
          { class: "list-row" },
          h("span", { class: "list-text" }, h("strong", {}, j.title), h("span", { class: "hint" }, ` Stopped at ${j.percent} %, ${formatBytes(j.bytes)} kept`)),
          h(
            "span",
            { class: "actions" },
            button("Resume", () => deps.openUrl(j.pageUrl), { variant: "primary", label: `Resume ${j.title}`, key: `resume-${j.id}` }),
            button("Discard", async () => (await deps.data.discard(j.id), await reloadLists(), render()), { label: `Discard ${j.title}`, key: `discard-${j.id}` }),
          ),
        ),
      );
    }
    return section("Stopped downloads", "stopped", list);
  }

  function historyView(): HTMLElement {
    const list = h("ul", { class: "list" });
    for (const e of s.history) {
      list.append(
        h(
          "li",
          { class: "list-row" },
          h("span", { class: "list-text" }, h("strong", {}, e.title), h("span", { class: "hint" }, ` ${e.site}${e.bytes !== undefined ? `, ${formatBytes(e.bytes)}` : ""}`)),
          h(
            "span",
            { class: "actions" },
            button("Re-download", () => deps.openUrl(e.pageUrl), { label: `Re-download ${e.title}`, key: `redo-${e.id}` }),
            e.downloadId !== undefined && button("Show in folder", () => deps.showDownload(e.downloadId!), { label: `Show ${e.title} in folder`, key: `show-${e.id}` }),
          ),
        ),
      );
    }
    const clear = button(
      "Clear all",
      async () => {
        await deps.data.clearAll();
        await reloadLists();
        showToast("History and stopped downloads cleared.", true);
        render();
      },
      { key: "clear-all", disabled: !s.history.length && !s.stopped.length },
    );
    return section("History", "history", s.history.length ? list : h("p", { class: "hint" }, "No downloads yet. The last 20 finished downloads appear here."), clear);
  }

  function toastView(): HTMLElement {
    const region = h("div", { class: "toast-region", role: "status", "aria-live": "polite" });
    if (s.toast) {
      const t = toast(s.toast.text);
      if (s.toast.undo) {
        t.append(
          " ",
          button(
            "Undo",
            async () => {
              await deps.data.undo();
              s.toast = undefined;
              await reloadLists();
              render();
            },
            { variant: "link", key: "undo" },
          ),
        );
      }
      region.append(t);
    }
    return region;
  }

  function render(focusKey?: string) {
    const active = document.activeElement as HTMLElement | null;
    const key = focusKey ?? (root.contains(active) ? active?.dataset.key : undefined);
    const frag = document.createDocumentFragment();
    frag.append(h("header", { class: "brand" }, h("img", { src: "/icons/icon-32.png", alt: "", width: 32, height: 32 }), h("h1", { class: "brand-name" }, "Frame Snap")));
    const notice = firstRun();
    if (notice) frag.append(notice);
    for (const part of [stoppedView(), historyView(), defaults(), images(), gifs(), sites(), appearance()]) if (part) frag.append(part);
    frag.append(h("footer", { class: "hint" }, `Works with ${supportedSiteNames().join(", ")}, and other sites you allow.`));
    frag.append(toastView());
    root.replaceChildren(frag);
    if (key) root.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus();
  }

  render();
  return { refresh: async () => (await reloadLists(), render()) };
}
