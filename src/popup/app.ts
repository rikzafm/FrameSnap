/**
 * Popup controller and views. State lives here; every change re-renders the
 * whole (small) tree and restores focus by `data-key`, so the DOM is always a
 * pure function of state. Messaging and storage come in through `PopupDeps`.
 */
import type { JobRecord } from "../core/jobs/job";
import type { WorkerToPopup, PopupToWorker } from "../core/messages";
import { ERROR_COPY, type ErrorCode } from "../core/errors";
import { clampTrim, defaultGifTrim } from "../core/gif";
import { resolveDefaultQuality } from "../core/settings";
import type { AudioMode, DownloadOptions, GifOptions, OutputFormat, VideoSource } from "../core/model";
import type { SiteAccessResult } from "../platform/site-access";
import { BURST_CAP, DEFAULT_SNAP_OPTIONS, type SnapFormat, type SnapOptions } from "../core/snap";
import { button, h, ICONS, iconButton, nextId, progress, radioCards, segmented, selectRow, svgIcon, switchControl, tabs, toast } from "../ui/components";
import type { Mode } from "./mode-memory";
import { errorNotice, errorToast, type ErrorHandlers } from "../ui/error-notice";
import { gifOptions, gifPanel, gifPreviewView, type GifChoices, type GifPreview } from "./gif-panel";
import { describeDownload, jobRowModel, qualityChoices, resumeBanner, type JobView } from "./model";

export interface PopupDeps {
  tab: { id: number; url: string };
  post(message: PopupToWorker): void;
  /** Must be called straight from a click handler (needs a user gesture). */
  requestAccess(): Promise<SiteAccessResult>;
  now(): Date;
  defaults: { format: OutputFormat; filenameTemplate: string; quality?: string; audio?: AudioMode };
  /** Shows the first-run notice until the user acknowledges it. */
  firstRun?: { onAcknowledge(): void };
  mode: Mode;
  onModeChange(mode: Mode): void;
  /** True when the site is already allowed, so the Remember switch starts on. */
  hasAccess?: boolean;
  /** Saved Screenshot-tab choices; `onChange` persists them for the shortcut and the on-video button. */
  snap?: { options: SnapOptions; onChange(options: SnapOptions): void };
  /** The in-page picker asked for this video on this tab (e.g. its GIF button). */
  pick?: { sourceId: string; mode: Mode };
  /** Extension version for the header ("v0.1 · Extension"). */
  version?: string;
}

interface JobMeta extends JobView {
  sourceId?: string;
  options?: DownloadOptions;
  /** Set for GIF jobs, so Retry makes a GIF again. */
  gif?: GifOptions;
  /** Last progress sample, for the speed estimate. */
  sampleAt?: number;
  /** Bytes held at the last sample. */
  sampleRatio?: number;
}

const FORMATS: OutputFormat[] = ["mp4", "webm", "mkv", "mov", "mp3", "m4a"];
const MODE_TABS = [
  { value: "video", label: "Video" },
  { value: "gif", label: "GIF" },
  { value: "screenshot", label: "Screenshot" },
];
const PANEL_ID = "mode-panel";

function fmtDuration(s?: number): string {
  if (s === undefined) return "";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function createPopup(root: HTMLElement, deps: PopupDeps) {
  const s = {
    loaded: false,
    sources: [] as VideoSource[],
    selectedId: deps.pick?.sourceId as string | undefined,
    /** The picker named a video: show it alone with its tabs even when several were found. */
    focused: deps.pick !== undefined,
    gif: { fps: 15, width: 480 as GifOptions["width"], loop: 0, dither: true, trim: { start: 0, end: 2 }, forSource: undefined as string | undefined },
    previews: new Map<string, GifPreview>(),
    mode: deps.pick?.mode ?? deps.mode,
    format: deps.defaults.format,
    /** Set once the user picks a quality; until then the saved default applies. */
    quality: undefined as string | undefined,
    audio: (deps.defaults.audio ?? "keep") as AudioMode,
    firstRun: deps.firstRun !== undefined,
    trimOn: false,
    nameOpen: false,
    /** Empty view: "pick" (default) or "auto". */
    emptyTab: "pick" as "pick" | "auto",
    trimStart: 0,
    trimEnd: 0,
    template: deps.defaults.filenameTemplate,
    remembered: deps.hasAccess === true,
    jobs: new Map<string, JobMeta>(),
    pending: [] as { title: string; sourceId: string; options: DownloadOptions; gif?: GifOptions; totalBytes?: number }[],
    resumable: [] as JobRecord[],
    bannerOpen: false,
    toast: undefined as string | undefined,
    toastError: undefined as ErrorCode | undefined,
    snap: deps.snap?.options ?? DEFAULT_SNAP_OPTIONS,
    burstEvery: 5,
    bursting: false,
  };
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  /** A GIF trim drag is in progress: a re-render would destroy the strip under the pointer, so renders wait for the drag to commit. */
  let dragging = false;
  const selected = () => s.sources.find((x) => x.id === s.selectedId) ?? s.sources[0];

  function showToast(text: string, error?: ErrorCode) {
    s.toast = text;
    s.toastError = error;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      s.toast = undefined;
      s.toastError = undefined;
      render();
    }, error ? 8000 : 4000);
  }

  const quality = (src: VideoSource): string => s.quality ?? resolveDefaultQuality(src, deps.defaults.quality ?? "best");

  function grantAccess() {
    void deps.requestAccess().then((r) => {
      s.remembered = r === "granted" || r === "already";
      if (r === "denied") showToast(ERROR_COPY.permission.message, "permission");
      render("remember");
    });
  }

  /** Switch to the next lower rendition than the current choice (or the lowest one). */
  function chooseLowerQuality(src: VideoSource) {
    const variants = qualityChoices(src).slice(1);
    const cur = quality(src);
    const at = cur === "best" ? 0 : variants.findIndex((c) => c.value === cur);
    const next = variants[Math.min(variants.length - 1, at + 1)];
    if (next) s.quality = next.value;
    s.selectedId = src.id;
    render();
  }

  const isBlocked = (src: VideoSource) => src.protection === "drm";

  function options(src: VideoSource): DownloadOptions {
    const o: DownloadOptions = { format: s.format, quality: quality(src), audio: s.audio, filenameTemplate: s.template };
    const end = Math.min(s.trimEnd || (src.duration ?? 0), src.duration ?? Infinity);
    if (s.trimOn && end > s.trimStart) o.trim = { start: s.trimStart, end };
    return o;
  }

  function startDownload(src: VideoSource, opts: DownloadOptions) {
    s.pending.push({ title: src.title, sourceId: src.id, options: opts, totalBytes: describeDownload(src, opts, deps.now()).estimateBytes });
    deps.post({ t: "job/download", tabId: deps.tab.id, sourceId: src.id, options: opts });
  }

  function gifChoices(src: VideoSource): GifChoices {
    if (s.gif.forSource !== src.id) {
      s.gif.trim = defaultGifTrim(src.dom?.currentTime ?? 0, src.duration);
      s.gif.forSource = src.id;
    }
    return { fps: s.gif.fps as GifChoices["fps"], width: s.gif.width, loop: s.gif.loop, dither: s.gif.dither, trim: s.gif.trim };
  }

  function makeGif(src: VideoSource) {
    const options = gifOptions(gifChoices(src));
    s.pending.push({ title: src.title, sourceId: src.id, options: { format: "mp4", quality: "best", audio: "remove", filenameTemplate: s.template }, gif: options });
    deps.post({ t: "job/gif", tabId: deps.tab.id, sourceId: src.id, options });
  }

  function gifTab(src: VideoSource): HTMLElement {
    const busy = [...s.jobs.values()].some((j) => j.gif !== undefined && (j.status === "queued" || j.status === "running"));
    return gifPanel({
      src,
      choices: gifChoices(src),
      busy,
      onMake: () => makeGif(src),
      // only a source with a page element can be seeked; others would hit whichever video ranks best
      ...(src.frameRef?.elementKey ? { onSeek: (time: number) => deps.post({ t: "snap/seek", tabId: deps.tab.id, sourceId: src.id, time }) } : {}),
      onDrag: (active) => (dragging = active),
      onChange: (patch, focusKey) => {
        const { trim, ...rest } = patch;
        Object.assign(s.gif, rest);
        if (trim) s.gif.trim = clampTrim(trim, src.duration);
        render(focusKey);
      },
    });
  }

  /* ---------- views ---------- */

  function hostLabel(): string {
    try {
      return new URL(deps.tab.url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }

  function brand(context: string): HTMLElement {
    return h("header", { class: "brand" }, h("h1", { class: "brand-name" }, "Frame Snap"), h("span", { class: "brand-context" }, context));
  }

  function bannerView(): HTMLElement | undefined {
    const b = resumeBanner(s.resumable);
    if (!b) return undefined;
    const resume = (id: string) => {
      deps.post({ t: "job/resume", jobId: id, tabId: deps.tab.id });
      s.resumable = s.resumable.filter((j) => j.id !== id);
      render();
    };
    const discard = (id: string) => {
      deps.post({ t: "job/discard", jobId: id });
      s.resumable = s.resumable.filter((j) => j.id !== id);
      render();
    };
    if (!b.many) {
      const id = b.jobIds[0]!;
      return h("section", { class: "banner", "aria-label": "Interrupted download" }, h("p", { class: "banner-text" }, b.text), h("div", { class: "actions" }, button("Resume", () => resume(id), { variant: "primary" }), button("Discard", () => discard(id))));
    }
    const listId = "banner-list";
    const el = h("section", { class: "banner", "aria-label": "Interrupted downloads" }, button(b.text, () => ((s.bannerOpen = !s.bannerOpen), render()), { variant: "link", expanded: s.bannerOpen, controls: s.bannerOpen ? listId : undefined, key: "banner-toggle" }));
    if (s.bannerOpen) {
      const ul = h("ul", { class: "banner-list", id: listId });
      for (const j of b.jobs) {
        ul.append(
          h(
            "li",
            {},
            h("span", { class: "banner-text" }, `${j.title} (${j.percent} %)`),
            h("span", { class: "actions" }, button("Resume", () => resume(j.id), { label: `Resume ${j.title}` }), button("Discard", () => discard(j.id), { label: `Discard ${j.title}` })),
          ),
        );
      }
      el.append(ul);
    }
    return el;
  }

  function summary(src: VideoSource): HTMLElement {
    const d = describeDownload(src, options(src), deps.now());
    const meta = [d.heightLabel, d.estimate].filter(Boolean).join(" · ");
    const duration = fmtDuration(src.duration);
    return h(
      "section",
      { class: "summary", "aria-label": "Selected video" },
      src.thumbnail ? h("img", { class: "thumb", src: src.thumbnail, alt: "" }) : svgIcon(ICONS.play, "thumb thumb-empty"),
      h(
        "div",
        { class: "card-text" },
        h("p", { class: "eyebrow" }, `Detected · ${src.site}`),
        h("p", { class: "card-title" }, duration ? `${src.title}, ${duration}` : src.title),
        meta ? h("p", { class: "card-meta" }, meta) : undefined,
      ),
    );
  }

  /** "Best available" reads as the rendition it resolves to (e.g. 720p); the duplicate entry is folded into it. */
  function qualityOptions(src: VideoSource): { choices: { value: string; label: string }[]; value: string } {
    const all = qualityChoices(src);
    const top = all[1];
    const cur = quality(src);
    if (!top) return { choices: all, value: cur };
    return { choices: [{ value: "best", label: top.label }, ...all.slice(2)], value: cur === top.value ? "best" : cur };
  }

  function formatQualityRows(src: VideoSource): HTMLElement[] {
    const q = qualityOptions(src);
    return [
      selectRow("opt-format", "Format", "format", FORMATS.map((f) => ({ value: f, label: f.toUpperCase() })), s.format, (v) => ((s.format = v as OutputFormat), render())),
      selectRow("opt-quality", "Quality", "quality", q.choices, q.value, (v) => ((s.quality = v), render())),
    ];
  }

  function videoPanel(src: VideoSource): HTMLElement {
    const opts = options(src);
    const d = describeDownload(src, opts, deps.now());
    const panel = h("div", { class: "rows" });
    panel.append(
      ...formatQualityRows(src),
      selectRow(
        "opt-audio",
        "Audio",
        "audio",
        [{ value: "keep", label: "Keep audio" }, { value: "remove", label: "Remove audio" }, { value: "only", label: "Audio only" }],
        s.audio,
        (v) => ((s.audio = v as AudioMode), render()),
      ),
    );
    const full = src.duration ? `0:00 – ${fmtDuration(src.duration)}` : "Full length";
    const range = s.trimOn ? `${fmtDuration(s.trimStart)} – ${fmtDuration(s.trimEnd || src.duration)}` : full;
    panel.append(
      h(
        "div",
        { class: "row" },
        h("span", { class: "row-label" }, "Trim"),
        h("button", { type: "button", class: "pill", "aria-label": "Trim", "aria-expanded": String(s.trimOn), "aria-controls": "trim-fields", "data-key": "trim", onClick: () => ((s.trimOn = !s.trimOn), render("trim")) }, range),
      ),
    );
    if (s.trimOn) {
      const num = (label: string, id: string, value: number, set: (n: number) => void) =>
        h("label", { class: "trim-field", for: id }, label, h("input", { id, type: "number", min: 0, step: "0.1", value: String(value), "data-key": id, onInput: (e) => set(Number((e.target as HTMLInputElement).value) || 0) }));
      panel.append(h("div", { class: "row trim-fields", id: "trim-fields" }, num("Start (s)", "trim-start", s.trimStart, (n) => (s.trimStart = n)), num("End (s)", "trim-end", s.trimEnd || src.duration || 0, (n) => (s.trimEnd = n))));
    }
    panel.append(
      h(
        "div",
        { class: "row" },
        h("span", { class: "row-label" }, "File name"),
        h("button", { type: "button", class: "row-value filename-preview", id: "filename-preview", "aria-label": `File name: ${d.filename}`, "aria-expanded": String(s.nameOpen), "aria-controls": "name-edit", "data-key": "name", onClick: () => ((s.nameOpen = !s.nameOpen), render("name")) }, d.filename),
      ),
    );
    if (s.nameOpen) {
      panel.append(
        h(
          "div",
          { class: "row row-stack", id: "name-edit" },
          h("label", { class: "row-label", for: "opt-name" }, "File name template"),
          h("input", { id: "opt-name", type: "text", name: "template", value: s.template, spellcheck: "false", "data-key": "opt-name", onInput: (e) => ((s.template = (e.target as HTMLInputElement).value), updatePreview(src)) }),
        ),
      );
    }
    if (d.error) panel.append(h("p", { class: "warning", role: "alert" }, ERROR_COPY[d.error.code].message));
    for (const w of d.warnings) {
      if (w.code === "too-large") panel.append(errorNotice("too-large", { "lower-quality": () => chooseLowerQuality(src) }));
      else panel.append(h("p", { class: "warning", role: "status" }, w.text));
    }
    return panel;
  }

  function updatePreview(src: VideoSource) {
    const el = root.querySelector("#filename-preview");
    if (!el) return;
    const name = describeDownload(src, options(src), deps.now()).filename;
    el.textContent = name;
    el.setAttribute("aria-label", `File name: ${name}`);
  }

  function actions(src: VideoSource, opts: { gif?: boolean } = {}): HTMLElement {
    const d = describeDownload(src, options(src), deps.now());
    const protectedVideo = isBlocked(src);
    const blocked = d.error !== undefined || d.warnings.some((w) => w.code === "too-large");
    return h(
      "div",
      { class: "actions actions-main" },
      button("Download video", () => startDownload(src, options(src)), { variant: "primary", disabled: blocked, key: "download" }),
      opts.gif
        ? button("GIF", () => {
            s.focused = true;
            s.mode = "gif";
            s.selectedId = src.id;
            deps.onModeChange("gif");
            render("tab-gif");
          }, { key: "gif-open", disabled: protectedVideo })
        : undefined,
      button(svgIcon(ICONS.snap, "icon"), () => deps.post({ t: "snap/frame", tabId: deps.tab.id, sourceId: src.id }), { label: "Snap frame", key: "snap", disabled: protectedVideo }),
    );
  }

  function setSnap(patch: Partial<SnapOptions>) {
    s.snap = { ...s.snap, ...patch };
    deps.snap?.onChange(s.snap);
  }

  function screenshotPanel(src: VideoSource): HTMLElement {
    const panel = h("div", { class: "rows" });
    panel.append(
      selectRow("snap-format", "Format", "snap-format", [{ value: "png", label: "PNG" }, { value: "jpeg", label: "JPEG" }, { value: "webp", label: "WEBP" }], s.snap.format, (v) => (setSnap({ format: v as SnapFormat }), render())),
    );
    if (s.snap.format !== "png") {
      const out = h("output", { class: "estimate", for: "snap-quality" }, `${Math.round(s.snap.quality * 100)} %`);
      const range = h("input", {
        id: "snap-quality",
        name: "snap-quality",
        type: "range",
        min: 10,
        max: 100,
        step: 5,
        value: String(Math.round(s.snap.quality * 100)),
        "data-key": "snap-quality",
        onInput: (e) => {
          const pct = Number((e.target as HTMLInputElement).value) || 92;
          setSnap({ quality: pct / 100 });
          out.textContent = `${pct} %`;
        },
      });
      panel.append(h("div", { class: "row" }, h("label", { class: "row-label", for: "snap-quality" }, "Quality"), h("div", { class: "row-control" }, range, out)));
    }
    panel.append(
      h("div", { class: "row" }, h("span", { class: "row-label" }, "Copy to clipboard"), switchControl("Copy to clipboard", s.snap.copy, () => (setSnap({ copy: !s.snap.copy }), render("snap-copy")), "snap-copy")),
      h("div", { class: "row" }, h("span", { class: "row-label" }, "Snap button on videos"), switchControl("Snap button on videos", s.snap.showButton, () => (setSnap({ showButton: !s.snap.showButton }), render("snap-button")), "snap-button")),
    );
    const step = (dir: 1 | -1) => deps.post({ t: "snap/step", tabId: deps.tab.id, dir, sourceId: src.id });
    panel.append(
      h(
        "div",
        { class: "row" },
        h("span", { class: "row-label" }, "Frame"),
        h("span", { class: "actions" }, iconButton("◀", "Previous frame", () => step(-1), "snap-prev"), iconButton("▶", "Next frame", () => step(1), "snap-next")),
      ),
      h(
        "div",
        { class: "row row-stack" },
        h("label", { class: "row-label", for: "burst-every" }, `Burst: snap every N seconds (up to ${BURST_CAP} frames)`),
        h("input", { id: "burst-every", name: "burst-every", type: "number", min: 0.5, step: "0.5", value: String(s.burstEvery), "data-key": "burst-every", onInput: (e) => (s.burstEvery = Number((e.target as HTMLInputElement).value) || 1) }),
      ),
    );
    const burstBtn = s.bursting
      ? button("Stop burst", () => (deps.post({ t: "snap/burst-stop", tabId: deps.tab.id }), (s.bursting = false), render("burst")), { key: "burst" })
      : button("Start burst", () => (deps.post({ t: "snap/burst", tabId: deps.tab.id, sourceId: src.id, intervalSec: s.burstEvery, options: s.snap }), (s.bursting = true), render("burst")), { key: "burst" });
    return h(
      "div",
      { class: "rows" },
      panel,
      h("div", { class: "actions actions-main" }, button("Snap frame", () => deps.post({ t: "snap/frame", tabId: deps.tab.id, sourceId: src.id, options: s.snap }), { variant: "primary", key: "snap-frame" }), burstBtn),
    );
  }

  /** Protected video: listed, explained, and nothing can be started. Never tries to get around it. */
  function protectedPanel(src: VideoSource): HTMLElement {
    return h("div", { class: "panel", id: PANEL_ID }, errorNotice("drm", {}), actions(src));
  }

  const SITES = ["Reddit", "X", ...(typeof __YOUTUBE__ !== "undefined" && __YOUTUBE__ ? ["YouTube"] : []), "Discord"];
  const footer = () => h("p", { class: "footer-note" }, `${SITES.join(" · ")} and more`);

  function modeTabs(): HTMLElement {
    return tabs("Mode", MODE_TABS, s.mode, PANEL_ID, (v) => {
      s.mode = v as Mode;
      deps.onModeChange(s.mode);
      render(`tab-${v}`);
    });
  }

  function singleView(src: VideoSource): HTMLElement {
    if (isBlocked(src)) return h("div", { class: "view" }, summary(src), protectedPanel(src));
    const panel = h("div", { class: "panel", role: "tabpanel", id: PANEL_ID, "aria-labelledby": `tab-${s.mode}`, tabindex: 0 });
    if (s.mode === "video") panel.append(videoPanel(src), actions(src));
    else if (s.mode === "screenshot") panel.append(screenshotPanel(src));
    else panel.append(gifTab(src));
    const back =
      s.sources.length > 1 && deps.pick === undefined
        ? button("All videos", () => ((s.focused = false), render("not-listed")), { variant: "link", key: "all-videos" })
        : undefined;
    return h("div", { class: "view" }, back, summary(src), modeTabs(), panel, s.mode === "video" ? footer() : undefined);
  }

  function listView(): HTMLElement {
    const cur = selected()!;
    const view = h(
      "div",
      { class: "view" },
      h("h2", { class: "section-title found" }, h("span", { class: "dot", "aria-hidden": "true" }), `${s.sources.length} videos found on this page`),
      radioCards(
        "Videos on this page",
        s.sources.map((x) => {
          const d = describeDownload(x, { format: s.format, quality: "best", audio: s.audio, filenameTemplate: s.template }, deps.now());
          return { value: x.id, title: x.title, meta: [fmtDuration(x.duration), d.heightLabel, d.estimate].filter(Boolean).join(" · "), thumbnail: x.thumbnail };
        }),
        cur.id,
        (id) => {
          s.selectedId = id;
          s.quality = undefined;
          render(`card-${id}`);
        },
      ),
    );
    if (isBlocked(cur)) view.append(errorNotice("drm", {}), actions(cur));
    else view.append(h("div", { class: "rows" }, ...formatQualityRows(cur)), actions(cur, { gif: true }));
    view.append(button("Not listed? Select a video on the page", () => deps.post({ t: "picker/start", tabId: deps.tab.id }), { variant: "link", key: "not-listed" }));
    return view;
  }

  function emptyView(): HTMLElement {
    const picking = s.emptyTab === "pick";
    const labelId = nextId("empty-mode");
    const toggle = segmented(
      labelId,
      [{ value: "auto", label: "Auto-detect" }, { value: "pick", label: "Pick on page" }],
      s.emptyTab,
      (v) => ((s.emptyTab = v as "pick" | "auto"), render(`seg-${v}`)),
      "toggle",
    );
    const card = h(
      "section",
      { class: "empty-card" },
      svgIcon(ICONS.cursor, "icon empty-icon"),
      h("h2", { class: "empty-title" }, picking ? "No video found automatically" : "Nothing detected yet"),
      h("p", { class: "empty-text" }, picking ? "Some embeds are hidden from detection. Point at the video yourself." : "Play the video, then reopen this popup. Or switch to Pick on page."),
    );
    const sw = switchControl("Remember my choice on this site", s.remembered, () => {
      if (s.remembered) return;
      grantAccess();
    }, "remember");
    return h(
      "div",
      { class: "view empty" },
      h("span", { class: "sr-only", id: labelId }, "Detection mode"),
      toggle,
      card,
      picking
        ? h("ol", { class: "steps" }, h("li", {}, "Press Start picking. The popup closes."), h("li", {}, "Hover a video on the page until it is outlined."), h("li", {}, "Click it to download, make a GIF or snap a frame."))
        : undefined,
      h("div", { class: "row remember" }, h("span", { class: "row-label" }, "Remember my choice on this site"), sw),
      picking ? button("Start picking", () => deps.post({ t: "picker/start", tabId: deps.tab.id }), { variant: "primary", key: "pick" }) : undefined,
    );
  }

  function jobsView(): HTMLElement | undefined {
    if (s.jobs.size === 0) return undefined;
    const list = h("ul", { class: "jobs" });
    for (const j of s.jobs.values()) {
      const m = jobRowModel(j);
      const li = h("li", { class: "job" }, h("p", { class: "card-title" }, m.title), h("p", { class: "card-meta" }, `${m.label} · ${m.percent} %`));
      if (m.detail) li.append(h("p", { class: "card-meta job-detail" }, m.detail));
      if (j.status === "running" || j.status === "queued") li.append(progress(`${m.title} progress`, m.percent));
      const failedCode = j.status === "failed" ? j.error?.code : undefined;
      if (failedCode && ["pick", "grant", "lower-quality"].includes(ERROR_COPY[failedCode].action)) {
        const jobSource = s.sources.find((x) => x.id === j.sourceId) ?? selected();
        const handlers: ErrorHandlers = {
          pick: () => deps.post({ t: "picker/start", tabId: deps.tab.id }),
          grant: grantAccess,
          "lower-quality": () => jobSource && chooseLowerQuality(jobSource),
        };
        li.append(errorNotice(failedCode, handlers));
      } else if (m.message) li.append(h("p", { class: "warning", role: "status" }, m.message));
      const row = h("div", { class: "actions" });
      if (m.actions.includes("cancel")) row.append(button("Cancel", () => deps.post({ t: "job/cancel", jobId: j.jobId }), { label: `Cancel ${m.title}` }));
      if (m.actions.includes("resume")) row.append(button(m.resumeLabel ?? "Resume", () => deps.post({ t: "job/resume", jobId: j.jobId, tabId: deps.tab.id }), { variant: "primary" }));
      if (m.actions.includes("retry")) {
        row.append(
          button("Retry", () => {
            if (j.sourceId && j.options) {
              const src = s.sources.find((x) => x.id === j.sourceId);
              if (!src) return;
              if (j.gif) {
                s.pending.push({ title: src.title, sourceId: src.id, options: j.options, gif: j.gif });
                deps.post({ t: "job/gif", tabId: deps.tab.id, sourceId: src.id, options: j.gif });
              } else startDownload(src, j.options);
            }
          }, { variant: "primary" }),
        );
      }
      if (row.childElementCount) li.append(row);
      list.append(li);
    }
    return h("section", { class: "jobs-section", "aria-label": "Downloads" }, list);
  }

  /** Folds a progress event into the job, keeping a smoothed bytes-per-second estimate while fetching. */
  function sampleProgress(base: JobMeta, phase: JobMeta["phase"], ratio: number, bytes?: number, totalBytes?: number): JobMeta {
    const at = deps.now().getTime();
    const next: JobMeta = { ...base, status: "running", phase, ratio, ...(totalBytes ? { totalBytes } : {}), doneBytes: phase === "fetch" ? bytes : undefined };
    if (phase !== "fetch") return { ...next, speed: undefined };
    const total = next.totalBytes ?? 0;
    // bytes are exact; without them fall back to ratio x estimated size
    const held = bytes ?? ratio * total;
    if (base.sampleAt === undefined || base.sampleRatio === undefined) return { ...next, sampleAt: at, sampleRatio: held };
    const dt = (at - base.sampleAt) / 1000;
    const delta = held - base.sampleRatio;
    // chunks land in bursts: wait for a real change before moving the estimate
    if (dt < 0.25 || delta <= 0) return next;
    const inst = delta / dt;
    return { ...next, sampleAt: at, sampleRatio: held, speed: base.speed ? base.speed * 0.6 + inst * 0.4 : inst };
  }

  /* ---------- render ---------- */

  function render(focusKey?: string) {
    // the drag's commit renders everything once it ends
    if (dragging) return;
    const active = document.activeElement as HTMLElement | null;
    const key = focusKey ?? (root.contains(active) ? active?.dataset.key : undefined);
    const caret = active instanceof HTMLInputElement && root.contains(active) ? active.selectionStart : null;

    const frag = document.createDocumentFragment();
    const cur = selected();
    const single = s.loaded && cur !== undefined && (s.sources.length === 1 || s.focused);
    frag.append(brand(single ? `v${deps.version ?? "1.0"} · Extension` : hostLabel()));
    if (s.firstRun) {
      frag.append(
        h(
          "section",
          { class: "banner first-run", "aria-label": "Before you start" },
          h("p", { class: "banner-text" }, "Only save content you have the right to use."),
          button("Got it", () => ((s.firstRun = false), deps.firstRun?.onAcknowledge(), render()), { variant: "primary", key: "first-run-ack" }),
        ),
      );
    }
    const banner = bannerView();
    if (banner) frag.append(banner);
    if (!s.loaded) frag.append(h("p", { class: "shell", role: "status" }, "Looking for videos…"));
    else if (!cur) frag.append(emptyView());
    else if (s.sources.length === 1 || s.focused) frag.append(singleView(cur));
    else frag.append(listView());
    const previews = gifPreviewView(
      [...s.previews.values()],
      (id) => deps.post({ t: "job/save", jobId: id }),
      (id) => {
        deps.post({ t: "job/cancel", jobId: id });
        s.previews.delete(id);
        render();
      },
    );
    if (previews) frag.append(previews);
    const jobs = jobsView();
    if (jobs) frag.append(jobs);
    frag.append(h("div", { class: "toast-region", role: "status", "aria-live": "polite" }, s.toast ? (s.toastError ? errorToast(s.toastError, { grant: grantAccess }) : toast(s.toast)) : undefined));
    root.replaceChildren(frag);

    if (key) {
      const el = root.querySelector<HTMLElement>(`[data-key="${key}"]`);
      el?.focus();
      if (el instanceof HTMLInputElement && caret !== null) el.setSelectionRange(caret, caret);
    }
  }

  render();

  return {
    handle(msg: WorkerToPopup) {
      if (msg.t === "media/updated") {
        if (msg.tabId !== deps.tab.id) return;
        s.loaded = true;
        s.sources = msg.sources;
        if (msg.resumable) s.resumable = msg.resumable;
        s.selectedId = msg.selectedId ?? (s.sources.some((x) => x.id === s.selectedId) ? s.selectedId : s.sources[0]?.id);
        render();
        return;
      }
      if (msg.t !== "job/event") return;
      const e = msg.event;
      const prev = s.jobs.get(e.jobId);
      if (e.t === "queued") {
        const p = s.pending.shift();
        s.jobs.set(e.jobId, { jobId: e.jobId, title: p?.title ?? "Download", status: "queued", phase: "fetch", ratio: 0, sourceId: p?.sourceId, options: p?.options, gif: p?.gif, totalBytes: p?.totalBytes });
      } else {
        const base: JobMeta = prev ?? { jobId: e.jobId, title: "Download", status: "running", phase: "fetch", ratio: 0 };
        if (e.t === "failed") s.previews.delete(e.jobId);
        if (e.t === "gif-ready") {
          s.jobs.delete(e.jobId);
          s.previews.set(e.jobId, { jobId: e.jobId, url: e.url, bytes: e.bytes, filename: e.filename, title: e.title });
        } else if (e.t === "progress") s.jobs.set(e.jobId, sampleProgress(base, e.phase, e.ratio, e.bytes, e.totalBytes));
        else if (e.t === "done") {
          s.previews.delete(e.jobId);
          s.jobs.set(e.jobId, { ...base, status: "done", ratio: 1 });
          showToast(`Saved ${e.filename}`);
        } else if (e.t === "failed") s.jobs.set(e.jobId, { ...base, status: "failed", error: e.error, resumable: e.resumable, keptRatio: e.keptRatio });
        else if (e.t === "cancelled") {
          s.previews.delete(e.jobId);
          s.jobs.set(e.jobId, { ...base, status: "cancelled" });
        } else if (e.t === "notice") showToast(ERROR_COPY[e.code].message);
        else if (e.t === "resume-needs-pick") {
          s.jobs.set(e.jobId, { ...base, status: "failed", error: { code: "not-found", message: ERROR_COPY["not-found"].message, retryable: true }, resumable: false });
          deps.post({ t: "picker/start", tabId: deps.tab.id, resumeJobId: e.jobId });
        }
      }
      render();
    },
    setResumable(jobs: JobRecord[]) {
      s.resumable = jobs;
      render();
    },
  };
}

