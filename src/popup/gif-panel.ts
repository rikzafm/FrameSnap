/**
 * GIF tab views: the frame strip with two trim handles, option chips, the size
 * estimate and the Save / Discard preview. State lives in the popup controller;
 * this file only renders it and reports changes.
 */
import { describeGif, dragHandle, GIF_DRAG_STEP, GIF_TRIM_STEP, gifSourceSize, nearestHandle, pickGifVariant, setHandle, shiftRange } from "../core/gif";
import { formatBytes } from "../core/format";
import type { GifOptions, TrimRange, VideoSource } from "../core/model";
import { button, h, nextId, segmented, switchControl } from "../ui/components";
import { gifMemoryWarning } from "./model";

export interface GifChoices {
  fps: GifOptions["fps"];
  width: GifOptions["width"];
  loop: number;
  dither: boolean;
  trim: TrimRange;
}

export interface GifPreview {
  jobId: string;
  url: string;
  bytes: number;
  filename: string;
  title: string;
}

const FPS = [10, 15, 24, 30] as const;
const WIDTHS = [320, 480, 640, "original"] as const;
const LOOPS = [0, 1, 2, 3] as const;
const sec = (n: number) => `${n.toFixed(1)} s`;

export const gifOptions = (c: GifChoices): GifOptions => ({ trim: c.trim, fps: c.fps, width: c.width, loop: c.loop, dither: c.dither });

export interface GifPanelProps {
  src: VideoSource;
  choices: GifChoices;
  onChange(patch: Partial<GifChoices>, focusKey?: string): void;
  onMake(): void;
  /** A GIF job for this popup is running. */
  busy: boolean;
  /** Seek the page video to this time (trim preview). */
  onSeek?(time: number): void;
  /** A trim drag started or ended. */
  onDrag?(active: boolean): void;
}

/** Page-video seeks while dragging are sent at most this often. */
const SEEK_INTERVAL_MS = 100;

interface StripProps {
  src: VideoSource;
  trim: TrimRange;
  /** Final range after a drag or key press; the panel re-renders from it. */
  onCommit(trim: TrimRange, focusKey: string): void;
  /** Every pointer move: update text outside the strip without re-rendering. */
  onLive(trim: TrimRange): void;
  /** Show this time in the page video. */
  onSeek?(time: number): void;
  /** A drag started (true) or ended (false); the popup holds re-renders meanwhile. */
  onDrag?(active: boolean): void;
}

const KEY_STEPS: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 10, PageDown: -10 };

/**
 * Strip with the range bar and two handles. A drag paints the strip in place
 * and commits once on release, so the element under the pointer survives the
 * whole gesture. Pressing the bar slides the range; pressing empty strip
 * grabs the nearer handle and jumps it there.
 */
function strip(p: StripProps): HTMLElement {
  const { src } = p;
  let trim = p.trim;
  const total = Math.max(src.duration ?? 0, trim.end);
  const pct = (t: number) => `${Math.min(100, Math.max(0, (t / total) * 100))}%`;
  const bar = h("div", { class: "gif-range" });
  const tip = h("div", { class: "gif-tip", "aria-hidden": "true" });
  tip.hidden = true;
  const el = h("div", { class: "gif-strip", style: src.thumbnail ? `background-image:url("${src.thumbnail.replace(/"/g, "%22")}")` : undefined }, bar);
  const keyOf = (which: "start" | "end") => (which === "start" ? "gif-start" : "gif-end");

  let lastSeek = 0;
  let seekTimer: ReturnType<typeof setTimeout> | undefined;
  const seek = (t: number, now = false) => {
    if (!p.onSeek) return;
    if (seekTimer) clearTimeout(seekTimer);
    seekTimer = undefined;
    const wait = SEEK_INTERVAL_MS - (performance.now() - lastSeek);
    const fire = () => {
      lastSeek = performance.now();
      p.onSeek!(t);
    };
    if (now || wait <= 0) fire();
    else seekTimer = setTimeout(fire, wait);
  };

  const handle = (which: "start" | "end") => {
    const hd = h("div", {
      class: `gif-handle gif-handle-${which}`,
      role: "slider",
      tabindex: 0,
      "aria-label": which === "start" ? "GIF start" : "GIF end",
      "data-key": keyOf(which),
      onKeydown: (e) => {
        const ke = e as KeyboardEvent;
        const dir = KEY_STEPS[ke.key];
        if (!dir) return;
        ke.preventDefault();
        // Shift+arrow nudges by the fine drag step; PageUp/PageDown jump 10 coarse steps.
        const step = ke.shiftKey && Math.abs(dir) === 1 ? GIF_DRAG_STEP : GIF_TRIM_STEP;
        const next = setHandle(trim, which, trim[which] + dir * step, src.duration);
        seek(next[which], true);
        p.onCommit(next, keyOf(which));
      },
    });
    return hd;
  };
  const handles = { start: handle("start"), end: handle("end") };

  function paint() {
    bar.style.left = pct(trim.start);
    bar.style.width = `calc(${pct(trim.end)} - ${pct(trim.start)})`;
    for (const which of ["start", "end"] as const) {
      const hd = handles[which];
      hd.style.left = pct(trim[which]);
      hd.setAttribute("aria-valuemin", String(which === "start" ? 0 : Number(trim.start.toFixed(3))));
      hd.setAttribute("aria-valuemax", String(which === "start" ? Number(trim.end.toFixed(3)) : Number(total.toFixed(3))));
      hd.setAttribute("aria-valuenow", String(Number(trim[which].toFixed(3))));
      hd.setAttribute("aria-valuetext", sec(trim[which]));
    }
  }

  el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return;
    const timeAt = (x: number) => Math.min(total, Math.max(0, ((x - rect.left) / rect.width) * total));
    const target = e.target as Node;
    const t0 = timeAt(e.clientX);
    let mode: "start" | "end" | "range";
    if (handles.start.contains(target)) mode = "start";
    else if (handles.end.contains(target)) mode = "end";
    else if (bar.contains(target)) mode = "range";
    else {
      mode = nearestHandle(trim, t0);
      trim = dragHandle(trim, mode, t0, src.duration);
    }
    const origin = trim;
    const focusKey = keyOf(mode === "range" ? "start" : mode);

    e.preventDefault();
    (mode === "range" ? handles.start : handles[mode]).focus({ preventScroll: true });
    el.setPointerCapture?.(e.pointerId);
    el.classList.add(mode === "range" ? "is-sliding" : "is-dragging");
    p.onDrag?.(true);

    const update = () => {
      paint();
      tip.hidden = false;
      tip.textContent = mode === "range" ? `${sec(trim.start)} – ${sec(trim.end)}` : sec(trim[mode]);
      // centred on the handle (or the bar), kept inside the strip so it never widens the popup
      const at = mode === "range" ? (trim.start + trim.end) / 2 : trim[mode];
      const w = el.clientWidth;
      const half = tip.offsetWidth / 2;
      tip.style.left = `${Math.min(Math.max((at / total) * w, half), Math.max(half, w - half))}px`;
      p.onLive(trim);
      seek(mode === "end" ? trim.end : trim.start);
    };
    const move = (m: PointerEvent) => {
      const t = timeAt(m.clientX);
      // Measured from the press, so a range pushed by the length cap springs back when dragged back.
      trim = mode === "range" ? shiftRange(origin, t - t0, src.duration) : dragHandle(origin, mode, t, src.duration);
      update();
    };
    const end = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", end);
      el.removeEventListener("pointercancel", end);
      el.classList.remove("is-dragging", "is-sliding");
      tip.hidden = true;
      seek(mode === "end" ? trim.end : trim.start, true);
      p.onDrag?.(false);
      p.onCommit(trim, focusKey);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    update();
  });

  el.append(handles.start, handles.end, tip);
  paint();
  return el;
}

const rangeText = (t: TrimRange) => `${sec(t.start)} → ${sec(t.end)}`;

export function gifPanel(p: GifPanelProps): HTMLElement {
  const { src, choices: c } = p;
  const panel = h("div", { class: "rows" });

  let size = { width: 1280, height: 720 };
  try {
    size = gifSourceSize(pickGifVariant(src, c.width));
  } catch {
    /* no playable variant: the estimate falls back to 16:9 */
  }
  const estimateText = (trim: TrimRange) => `Estimated size ${describeGif({ ...gifOptions(c), trim }, size).range}`;
  const label = h("span", { class: "gif-range-value" }, rangeText(c.trim));
  const estimate = h("p", { class: "estimate gif-estimate", role: "status" }, estimateText(c.trim));

  panel.append(
    h(
      "div",
      { class: "row row-stack gif-range-row" },
      h("div", { class: "gif-range-head" }, h("span", { class: "row-label" }, "Range"), h("span", { class: "gif-range-meta" }, label)),
      strip({
        src,
        trim: c.trim,
        onCommit: (trim, key) => p.onChange({ trim }, key),
        onLive: (trim) => {
          label.textContent = rangeText(trim);
          estimate.textContent = estimateText(trim);
        },
        ...(p.onSeek ? { onSeek: p.onSeek } : {}),
        ...(p.onDrag ? { onDrag: p.onDrag } : {}),
      }),
    ),
  );

  const row = (label: string, choices: { value: string; label: string }[], value: string, onPick: (v: string) => void) => {
    const id = nextId("gif-label");
    return h("div", { class: "row" }, h("span", { class: "row-label", id }, label), segmented(id, choices, value, (v) => onPick(v)));
  };
  panel.append(
    row("Frame rate", FPS.map((f) => ({ value: String(f), label: String(f) })), String(c.fps), (v) => p.onChange({ fps: Number(v) as GifOptions["fps"] }, `seg-${v}`)),
    row("Width", WIDTHS.map((w) => ({ value: String(w), label: w === "original" ? "Original" : String(w) })), String(c.width), (v) => p.onChange({ width: v === "original" ? "original" : (Number(v) as 320 | 480 | 640) }, `seg-${v}`)),
    row("Loop", LOOPS.map((l) => ({ value: String(l), label: l === 0 ? "∞" : String(l) })), String(c.loop), (v) => p.onChange({ loop: Number(v) }, `seg-${v}`)),
    h("div", { class: "row" }, h("span", { class: "row-label" }, "Dither"), switchControl("Dither", c.dither, () => p.onChange({ dither: !c.dither }, "gif-dither"), "gif-dither")),
  );

  panel.append(estimate);
  const memory = gifMemoryWarning(gifOptions(c), size.width, size.height);
  if (memory) panel.append(h("p", { class: "warning", role: "status" }, memory));

  return h("div", { class: "rows" }, panel, h("div", { class: "actions actions-main" }, button(p.busy ? "Making GIF…" : "Make GIF", p.onMake, { variant: "primary", disabled: p.busy, key: "gif-make" })));
}

/** Result preview with Save / Discard; shown in every tab until the user decides. */
export function gifPreviewView(items: readonly GifPreview[], onSave: (id: string) => void, onDiscard: (id: string) => void): HTMLElement | undefined {
  if (items.length === 0) return undefined;
  const section = h("section", { class: "gif-previews", "aria-label": "GIF preview" });
  for (const it of items) {
    section.append(
      h(
        "div",
        { class: "gif-preview" },
        h("img", { class: "gif-preview-img", src: it.url, alt: `Preview of ${it.title}` }),
        h("p", { class: "card-meta" }, `${it.filename} · ${formatBytes(it.bytes)}`),
        h("div", { class: "actions" }, button("Save GIF", () => onSave(it.jobId), { variant: "primary", label: `Save ${it.filename}`, key: `gif-save-${it.jobId}` }), button("Discard", () => onDiscard(it.jobId), { label: `Discard ${it.filename}` })),
      ),
    );
  }
  return section;
}
