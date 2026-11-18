/**
 * GIF tab views: the frame strip with two trim handles, option chips, the size
 * estimate and the Save / Discard preview. State lives in the popup controller;
 * this file only renders it and reports changes.
 */
import { describeGif, GIF_TRIM_STEP, gifSourceSize, moveHandle, pickGifVariant } from "../core/gif";
import { formatBytes } from "../core/format";
import { GIF_MAX_SECONDS, type GifOptions, type TrimRange, type VideoSource } from "../core/model";
import { button, h, nextId, segmented, switchControl } from "../ui/components";

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
}

/** Strip with the range bar and two keyboard- and pointer-operable handles. */
function strip(src: VideoSource, trim: TrimRange, onTrim: (t: TrimRange, key: string) => void): HTMLElement {
  const total = Math.max(src.duration ?? 0, trim.end);
  const pct = (t: number) => `${Math.min(100, Math.max(0, (t / total) * 100))}%`;
  const bar = h("div", { class: "gif-range", style: `left:${pct(trim.start)};width:calc(${pct(trim.end)} - ${pct(trim.start)})` });
  const el = h("div", { class: "gif-strip", style: src.thumbnail ? `background-image:url("${src.thumbnail.replace(/"/g, "%22")}")` : undefined }, bar);

  const handle = (which: "start" | "end") => {
    const value = trim[which];
    const key = which === "start" ? "gif-start" : "gif-end";
    const label = which === "start" ? "GIF start" : "GIF end";
    const hd = h("div", {
      class: `gif-handle gif-handle-${which}`,
      role: "slider",
      tabindex: 0,
      "aria-label": label,
      "aria-valuemin": which === "start" ? 0 : Number(trim.start.toFixed(3)),
      "aria-valuemax": which === "start" ? Number(trim.end.toFixed(3)) : Number(total.toFixed(3)),
      "aria-valuenow": Number(value.toFixed(3)),
      "aria-valuetext": sec(value),
      "data-key": key,
      style: `left:${pct(value)}`,
      onKeydown: (e) => {
        const ke = e as KeyboardEvent;
        const steps = ke.key === "ArrowRight" || ke.key === "ArrowUp" ? 1 : ke.key === "ArrowLeft" || ke.key === "ArrowDown" ? -1 : ke.key === "PageUp" ? 10 : ke.key === "PageDown" ? -10 : 0;
        if (!steps) return;
        ke.preventDefault();
        onTrim(moveHandle(trim, which, steps, src.duration), key);
      },
    });
    hd.addEventListener("pointerdown", (e) => {
      const pe = e as PointerEvent;
      hd.setPointerCapture?.(pe.pointerId);
      const move = (m: Event) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0) return;
        const t = (((m as PointerEvent).clientX - rect.left) / rect.width) * total;
        const steps = (Math.round(t / GIF_TRIM_STEP) * GIF_TRIM_STEP - trim[which]) / GIF_TRIM_STEP;
        if (steps !== 0) onTrim(moveHandle(trim, which, steps, src.duration), key);
        hd.removeEventListener("pointermove", move);
      };
      hd.addEventListener("pointermove", move);
      hd.addEventListener("pointerup", () => hd.removeEventListener("pointermove", move), { once: true });
    });
    return hd;
  };
  el.append(handle("start"), handle("end"));
  return el;
}

export function gifPanel(p: GifPanelProps): HTMLElement {
  const { src, choices: c } = p;
  const panel = h("div", { class: "rows" });

  panel.append(
    h(
      "div",
      { class: "row row-stack" },
      h("span", { class: "row-label" }, `Range: ${sec(c.trim.start)} to ${sec(c.trim.end)} (${sec(c.trim.end - c.trim.start)}, up to ${GIF_MAX_SECONDS} s)`),
      strip(src, c.trim, (trim, key) => p.onChange({ trim }, key)),
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

  let size = { width: 1280, height: 720 };
  try {
    size = gifSourceSize(pickGifVariant(src, c.width));
  } catch {
    /* no playable variant: the estimate falls back to 16:9 */
  }
  const d = describeGif(gifOptions(c), size);
  panel.append(h("p", { class: "estimate gif-estimate", role: "status" }, `Estimated size ${d.range}`));
  if (d.lowMemory) panel.append(h("p", { class: "warning", role: "status" }, "This GIF is big for the converter and may run out of memory. Lower the width, the frame rate or the length."));

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
