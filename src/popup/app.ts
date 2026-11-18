/**
 * Popup controller and views. State lives here; every change re-renders the
 * whole (small) tree and restores focus by `data-key`, so the DOM is always a
 * pure function of state. Messaging and storage come in through `PopupDeps`.
 */
import type { JobRecord } from "../core/jobs/job";
import type { WorkerToPopup, PopupToWorker } from "../core/messages";
import { ERROR_COPY, type ErrorCode } from "../core/errors";
import type { AudioMode, DownloadOptions, OutputFormat, VideoSource } from "../core/model";
import type { SiteAccessResult } from "../platform/site-access";
import { BURST_CAP, DEFAULT_SNAP_OPTIONS, type SnapFormat, type SnapOptions } from "../core/snap";
import { button, h, iconButton, nextId, progress, radioCards, segmented, selectRow, switchControl, tabs, toast } from "../ui/components";
import type { Mode } from "./mode-memory";
import { errorNotice, errorToast, type ErrorHandlers } from "../ui/error-notice";
import { describeDownload, jobRowModel, qualityChoices, resumeBanner, type JobView } from "./model";

export interface PopupDeps {
  tab: { id: number; url: string };
  post(message: PopupToWorker): void;
  /** Must be called straight from a click handler (needs a user gesture). */
  requestAccess(): Promise<SiteAccessResult>;
  now(): Date;
  defaults: { format: OutputFormat; filenameTemplate: string };
  mode: Mode;
  onModeChange(mode: Mode): void;
  /** True when the site is already allowed, so the Remember switch starts on. */
  hasAccess?: boolean;
  /** Saved Screenshot-tab choices; `onChange` persists them for the shortcut and the on-video button. */
  snap?: { options: SnapOptions; onChange(options: SnapOptions): void };
}

interface JobMeta extends JobView {
  sourceId?: string;
  options?: DownloadOptions;
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
    selectedId: undefined as string | undefined,
    mode: deps.mode,
    format: deps.defaults.format,
    quality: "best",
    audio: "keep" as AudioMode,
    trimOn: false,
    trimStart: 0,
    trimEnd: 0,
    template: deps.defaults.filenameTemplate,
    remembered: deps.hasAccess === true,
    jobs: new Map<string, JobMeta>(),
    pending: [] as { title: string; sourceId: string; options: DownloadOptions }[],
    resumable: [] as JobRecord[],
    bannerOpen: false,
    toast: undefined as string | undefined,
    toastError: undefined as ErrorCode | undefined,
    snap: deps.snap?.options ?? DEFAULT_SNAP_OPTIONS,
    burstEvery: 5,
    bursting: false,
  };
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
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
    const at = s.quality === "best" ? 0 : variants.findIndex((c) => c.value === s.quality);
    const next = variants[Math.min(variants.length - 1, at + 1)];
    if (next) s.quality = next.value;
    s.selectedId = src.id;
    render();
  }

  const isBlocked = (src: VideoSource) => src.protection === "drm";

  function options(src: VideoSource): DownloadOptions {
    const o: DownloadOptions = { format: s.format, quality: s.quality, audio: s.audio, filenameTemplate: s.template };
    const end = Math.min(s.trimEnd || (src.duration ?? 0), src.duration ?? Infinity);
    if (s.trimOn && end > s.trimStart) o.trim = { start: s.trimStart, end };
    return o;
  }

  function startDownload(src: VideoSource, opts: DownloadOptions) {
    s.pending.push({ title: src.title, sourceId: src.id, options: opts });
    deps.post({ t: "job/download", tabId: deps.tab.id, sourceId: src.id, options: opts });
  }

  /* ---------- views ---------- */

  function brand(): HTMLElement {
    return h("header", { class: "brand" }, h("img", { src: "/icons/icon-32.png", alt: "", width: 32, height: 32 }), h("h1", { class: "brand-name" }, "Frame Snap"));
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
    const meta = [src.site, fmtDuration(src.duration)].filter(Boolean).join(" · ");
    return h(
      "section",
      { class: "summary", "aria-label": "Selected video" },
      src.thumbnail ? h("img", { class: "thumb", src: src.thumbnail, alt: "" }) : h("span", { class: "thumb thumb-empty", "aria-hidden": "true" }),
      h("div", { class: "card-text" }, h("p", { class: "card-title" }, src.title), h("p", { class: "card-meta" }, meta)),
    );
  }

  function videoPanel(src: VideoSource): HTMLElement {
    const opts = options(src);
    const d = describeDownload(src, opts, deps.now());
    const panel = h("div", { class: "rows" });
    panel.append(
      selectRow("opt-format", "Format", "format", FORMATS.map((f) => ({ value: f, label: f.toUpperCase() })), s.format, (v) => ((s.format = v as OutputFormat), render())),
      selectRow("opt-quality", "Quality", "quality", qualityChoices(src), s.quality, (v) => ((s.quality = v), render()), d.estimate ? h("span", { class: "estimate" }, d.estimate) : undefined),
    );
    const audioId = nextId("audio-label");
    panel.append(
      h(
        "div",
        { class: "row" },
        h("span", { class: "row-label", id: audioId }, "Audio"),
        segmented(audioId, [{ value: "keep", label: "Keep" }, { value: "remove", label: "Remove" }, { value: "only", label: "Audio only" }], s.audio, (v) => ((s.audio = v as AudioMode), render())),
      ),
    );
    const trimRow = h("div", { class: "row" }, h("span", { class: "row-label" }, "Trim"), switchControl("Trim", s.trimOn, () => ((s.trimOn = !s.trimOn), render()), "trim"));
    panel.append(trimRow);
    if (s.trimOn) {
      const num = (label: string, id: string, value: number, set: (n: number) => void) =>
        h("label", { class: "trim-field", for: id }, label, h("input", { id, type: "number", min: 0, step: "0.1", value: String(value), "data-key": id, onInput: (e) => set(Number((e.target as HTMLInputElement).value) || 0) }));
      panel.append(h("div", { class: "row trim-fields" }, num("Start (s)", "trim-start", s.trimStart, (n) => (s.trimStart = n)), num("End (s)", "trim-end", s.trimEnd || src.duration || 0, (n) => (s.trimEnd = n))));
    }
    panel.append(
      h(
        "div",
        { class: "row row-stack" },
        h("label", { class: "row-label", for: "opt-name" }, "File name"),
        h("input", { id: "opt-name", type: "text", name: "template", value: s.template, spellcheck: "false", "data-key": "opt-name", onInput: (e) => ((s.template = (e.target as HTMLInputElement).value), updatePreview(src)) }),
        h("p", { class: "filename-preview", id: "filename-preview" }, d.filename),
      ),
    );
    if (d.error) panel.append(h("p", { class: "warning", role: "alert" }, ERROR_COPY[d.error.code].message));
    for (const w of d.warnings) {
      if (w.code === "too-large") panel.append(errorNotice("too-large", { "lower-quality": () => chooseLowerQuality(src) }));
      else panel.append(h("p", { class: "warning", role: "status" }, w.text));
    }
    return panel;
  }

  function updatePreview(src: VideoSource) {
    const el = root.querySelector("#filename-preview");
    if (el) el.textContent = describeDownload(src, options(src), deps.now()).filename;
  }

  function actions(src: VideoSource, withDownload: boolean): HTMLElement {
    const d = describeDownload(src, options(src), deps.now());
    const protectedVideo = isBlocked(src);
    const blocked = d.error !== undefined || d.warnings.some((w) => w.code === "too-large");
    return h(
      "div",
      { class: "actions actions-main" },
      withDownload ? button("Download", () => startDownload(src, options(src)), { variant: "primary", disabled: blocked, key: "download" }) : undefined,
      button("Snap", () => deps.post({ t: "snap/frame", tabId: deps.tab.id, sourceId: src.id }), { key: "snap", disabled: protectedVideo }),
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
    return h("div", { class: "panel", id: PANEL_ID }, errorNotice("drm", {}), actions(src, true));
  }

  function singleView(src: VideoSource): HTMLElement {
    if (isBlocked(src)) return h("div", { class: "view" }, summary(src), protectedPanel(src));
    const panel = h("div", { class: "panel", role: "tabpanel", id: PANEL_ID, "aria-labelledby": `tab-${s.mode}`, tabindex: 0 });
    if (s.mode === "video") panel.append(videoPanel(src), actions(src, true));
    else if (s.mode === "screenshot") panel.append(screenshotPanel(src));
    else panel.append(h("p", { class: "shell" }, "GIF maker is coming soon."));
    return h(
      "div",
      { class: "view" },
      summary(src),
      tabs("Mode", MODE_TABS, s.mode, PANEL_ID, (v) => {
        s.mode = v as Mode;
        deps.onModeChange(s.mode);
        render(`tab-${v}`);
      }),
      panel,
    );
  }

  function listView(): HTMLElement {
    const cur = selected()!;
    const view = h("div", { class: "view" }, h("h2", { class: "section-title" }, `${s.sources.length} videos found`));
    view.append(
      radioCards(
        "Videos on this page",
        s.sources.map((x) => ({ value: x.id, title: x.title, meta: [x.site, fmtDuration(x.duration)].filter(Boolean).join(" · "), thumbnail: x.thumbnail })),
        cur.id,
        (id) => {
          s.selectedId = id;
          s.quality = "best";
          render(`card-${id}`);
        },
      ),
      button("Not listed?", () => deps.post({ t: "picker/start", tabId: deps.tab.id }), { variant: "link", key: "not-listed" }),
      ...(isBlocked(cur) ? [errorNotice("drm", {})] : []),
      actions(cur, true),
    );
    return view;
  }

  function emptyView(): HTMLElement {
    const steps = h("ol", { class: "steps" }, h("li", {}, "Open the page with the video."), h("li", {}, "Press Start picking."), h("li", {}, "Click the video you want."));
    const sw = switchControl("Remember this site", s.remembered, () => {
      if (s.remembered) return;
      grantAccess();
    }, "remember");
    return h(
      "div",
      { class: "view empty" },
      h("h2", { class: "section-title" }, "No video found yet"),
      steps,
      h("div", { class: "row" }, h("span", { class: "row-label" }, "Remember this site"), sw),
      button("Start picking", () => deps.post({ t: "picker/start", tabId: deps.tab.id }), { variant: "primary", key: "pick" }),
    );
  }

  function jobsView(): HTMLElement | undefined {
    if (s.jobs.size === 0) return undefined;
    const list = h("ul", { class: "jobs" });
    for (const j of s.jobs.values()) {
      const m = jobRowModel(j);
      const li = h("li", { class: "job" }, h("p", { class: "card-title" }, m.title), h("p", { class: "card-meta" }, `${m.label} · ${m.percent} %`));
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
              if (src) startDownload(src, j.options);
            }
          }, { variant: "primary" }),
        );
      }
      if (row.childElementCount) li.append(row);
      list.append(li);
    }
    return h("section", { class: "jobs-section", "aria-label": "Downloads" }, list);
  }

  /* ---------- render ---------- */

  function render(focusKey?: string) {
    const active = document.activeElement as HTMLElement | null;
    const key = focusKey ?? (root.contains(active) ? active?.dataset.key : undefined);
    const caret = active instanceof HTMLInputElement && root.contains(active) ? active.selectionStart : null;

    const frag = document.createDocumentFragment();
    frag.append(brand());
    const banner = bannerView();
    if (banner) frag.append(banner);
    const cur = selected();
    if (!s.loaded) frag.append(h("p", { class: "shell", role: "status" }, "Looking for videos…"));
    else if (!cur) frag.append(emptyView());
    else if (s.sources.length === 1) frag.append(singleView(cur));
    else frag.append(listView());
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
        s.selectedId = msg.selectedId ?? (s.sources.some((x) => x.id === s.selectedId) ? s.selectedId : s.sources[0]?.id);
        render();
        return;
      }
      if (msg.t !== "job/event") return;
      const e = msg.event;
      const prev = s.jobs.get(e.jobId);
      if (e.t === "queued") {
        const p = s.pending.shift();
        s.jobs.set(e.jobId, { jobId: e.jobId, title: p?.title ?? "Download", status: "queued", phase: "fetch", ratio: 0, sourceId: p?.sourceId, options: p?.options });
      } else {
        const base: JobMeta = prev ?? { jobId: e.jobId, title: "Download", status: "running", phase: "fetch", ratio: 0 };
        if (e.t === "progress") s.jobs.set(e.jobId, { ...base, status: "running", phase: e.phase, ratio: e.ratio });
        else if (e.t === "done") {
          s.jobs.set(e.jobId, { ...base, status: "done", ratio: 1 });
          showToast(`Saved ${e.filename}`);
        } else if (e.t === "failed") s.jobs.set(e.jobId, { ...base, status: "failed", error: e.error, resumable: e.resumable, keptRatio: e.keptRatio });
        else if (e.t === "cancelled") s.jobs.set(e.jobId, { ...base, status: "cancelled" });
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

