/**
 * In-page picker: the fallback for when detection lists the wrong video or none.
 *
 * The overlay lives in a closed shadow root with pointer-events none so the
 * page cannot see or style it. While picking, capture-phase listeners swallow
 * page clicks; `cancel()` removes every listener, so page handlers fire
 * normally afterwards.
 */
import { ERROR_COPY } from "../core/errors";
import type { ContentToWorker, PickerAction } from "../core/messages";
import type { VideoSource } from "../core/model";
import type { DomDetector } from "./dom-detect";

export interface PickerOptions {
  document: Document;
  detector: DomDetector;
  send: (message: ContentToWorker) => void;
  /** Tests use "open" so the overlay can be inspected. */
  shadowMode?: "open" | "closed";
}

export interface PickerStart {
  resumeJobId?: string;
  resumeTitle?: string;
}

export interface Picker {
  start(opts: PickerStart): void;
  cancel(): void;
  readonly active: boolean;
}

interface Entry {
  source: VideoSource;
  el: HTMLVideoElement;
}

const HOST_ATTR = "data-framesnap-picker";
const SWALLOWED = ["mousedown", "mouseup", "pointerdown", "pointerup", "dblclick", "contextmenu"] as const;

const CSS = `
:host { all: initial; }
.root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font: 500 13px/1.3 Inter, system-ui, sans-serif; }
.top { position: absolute; top: 0; left: 0; right: 0; display: flex; justify-content: space-between; align-items: center;
  padding: 10px 16px; background: #1d1b17; color: #faf8f3; pointer-events: auto; }
.top button, .bar button { font: inherit; cursor: pointer; border-radius: 6px; }
.top button { background: transparent; color: #faf8f3; border: 1px solid #faf8f380; padding: 4px 10px; }
.outline { position: absolute; box-sizing: border-box; border: 2px dashed #c23a08; }
.outline.selected { border-style: solid; }
.tag { position: absolute; left: -2px; top: -26px; padding: 3px 8px; background: #1d1b17; color: #faf8f3; border-radius: 4px; white-space: nowrap; }
.outline.selected .tag { background: #c23a08; }
.bar { position: absolute; display: flex; gap: 8px; padding: 8px; background: #1d1b17; border-radius: 8px; pointer-events: auto; }
.bar button { background: #faf8f3; color: #1d1b17; border: 0; padding: 6px 12px; }
.bar button.primary { background: #c23a08; color: #faf8f3; }
.bar button:disabled { opacity: 0.45; cursor: not-allowed; }
.bar { flex-wrap: wrap; max-width: 360px; }
.bar .note { flex-basis: 100%; margin: 0; color: #faf8f3; }
button:focus-visible { outline: 2px solid #faf8f3; outline-offset: 2px; }
`;

const dims = (r: DOMRect) => `${Math.round(r.width)}×${Math.round(r.height)}`;

/** All elements under a point, descending into shadow roots (open or closed, via the root we can reach). */
function deepElementsAt(root: Document | ShadowRoot, x: number, y: number): Element[] {
  const out: Element[] = [];
  for (const el of root.elementsFromPoint?.(x, y) ?? []) {
    if (el.shadowRoot) out.push(...deepElementsAt(el.shadowRoot, x, y));
    out.push(el);
  }
  return out;
}

export function createPicker(opts: PickerOptions): Picker {
  const { document: doc, detector, send, shadowMode = "closed" } = opts;
  const win = doc.defaultView!;

  let host: HTMLElement | undefined;
  let root: ShadowRoot | undefined;
  /** Fixed full-viewport layer: outline and bar coordinates are viewport-relative. */
  let layer: HTMLElement | undefined;
  let entries: Entry[] = [];
  let resume: PickerStart | undefined;
  let hovered: Entry | undefined;
  let selected: Entry | undefined;
  let focusIndex = -1;

  const refresh = () => {
    entries = detector
      .scan()
      .map((source) => ({ source, el: source.frameRef ? detector.resolve(source.frameRef.elementKey) : undefined }))
      .filter((e): e is Entry => e.el !== undefined);
  };

  const entryFor = (el: HTMLVideoElement): Entry | undefined => {
    let e = entries.find((x) => x.el === el);
    if (!e) {
      refresh();
      e = entries.find((x) => x.el === el);
    }
    return e;
  };

  const videoAt = (x: number, y: number): Entry | undefined => {
    const VideoCtor = win.HTMLVideoElement;
    const el = deepElementsAt(doc, x, y).find((e): e is HTMLVideoElement => e instanceof VideoCtor);
    return el && entryFor(el);
  };

  const ownEvent = (e: Event) => host !== undefined && e.composedPath().includes(host);

  function place(node: HTMLElement, r: DOMRect) {
    node.style.left = `${r.left}px`;
    node.style.top = `${r.top}px`;
    node.style.width = `${r.width}px`;
    node.style.height = `${r.height}px`;
  }

  function outline(kind: "hover" | "selected", entry: Entry | undefined, label: string) {
    layer?.querySelector(`[data-outline=${kind}]`)?.remove();
    if (!entry || !layer) return;
    const r = entry.el.getBoundingClientRect();
    const box = doc.createElement("div");
    box.className = kind === "selected" ? "outline selected" : "outline";
    box.dataset.outline = kind;
    place(box, r);
    const tag = doc.createElement("div");
    tag.className = "tag";
    tag.textContent = `${label} · ${dims(r)}`;
    box.append(tag);
    layer.append(box);
  }

  function actionBar() {
    layer?.querySelector(".bar")?.remove();
    if (!selected || !layer || resume) return;
    const r = selected.el.getBoundingClientRect();
    const bar = doc.createElement("div");
    bar.className = "bar";
    bar.style.left = `${Math.max(8, r.left)}px`;
    bar.style.top = `${Math.max(48, r.bottom + 8)}px`;
    const buttons: [PickerAction, string, boolean][] = [
      ["download", "Download MP4 ▾", true],
      ["gif", "GIF", false],
      ["snap", "Snap frame", false],
    ];
    const locked = selected.source.protection === "drm";
    if (locked) {
      const note = doc.createElement("p");
      note.className = "note";
      note.setAttribute("role", "alert");
      note.textContent = ERROR_COPY.drm.message;
      bar.append(note);
    }
    for (const [action, label, primary] of buttons) {
      const b = doc.createElement("button");
      b.disabled = locked;
      b.type = "button";
      b.dataset.action = action;
      b.textContent = label;
      if (primary) b.className = "primary";
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (selected) send({ t: "picker/action", action, source: selected.source });
        if (action !== "download") cancel();
      });
      bar.append(b);
    }
    layer.append(bar);
  }

  function render() {
    const shown = hovered && hovered !== selected ? hovered : undefined;
    outline("hover", shown, "Click to select");
    outline("selected", selected, "Selected");
    actionBar();
  }

  function select(entry: Entry) {
    selected = entry;
    hovered = undefined;
    send({ t: "picker/picked", source: entry.source, ...(resume?.resumeJobId ? { resumeJobId: resume.resumeJobId } : {}) });
    if (resume) {
      cancel();
      return;
    }
    render();
  }

  const onMove = (e: Event) => {
    const m = e as MouseEvent;
    const next = videoAt(m.clientX, m.clientY);
    if (next === hovered) return;
    hovered = next;
    focusIndex = next ? entries.indexOf(next) : -1;
    render();
  };

  const onClick = (e: Event) => {
    if (ownEvent(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const m = e as MouseEvent;
    const hit = videoAt(m.clientX, m.clientY);
    if (hit) select(hit);
  };

  const onSwallow = (e: Event) => {
    if (ownEvent(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  const onKey = (e: Event) => {
    const k = e as KeyboardEvent;
    if (k.key === "Escape") {
      k.preventDefault();
      k.stopImmediatePropagation();
      cancel();
    } else if (k.key === "Tab" && !ownEvent(e)) {
      k.preventDefault();
      k.stopImmediatePropagation();
      refresh();
      if (entries.length === 0) return;
      const step = k.shiftKey ? -1 : 1;
      focusIndex = (focusIndex + step + entries.length) % entries.length;
      hovered = entries[focusIndex];
      render();
    } else if (k.key === "Enter" && !ownEvent(e) && hovered) {
      k.preventDefault();
      k.stopImmediatePropagation();
      select(hovered);
    }
  };

  const onLayout = () => render();

  function start(o: PickerStart) {
    if (host) cancel();
    resume = o.resumeJobId ? o : undefined;
    refresh();
    host = doc.createElement("div");
    host.setAttribute(HOST_ATTR, "");
    root = host.attachShadow({ mode: shadowMode });
    const style = doc.createElement("style");
    style.textContent = CSS;
    const wrap = doc.createElement("div");
    wrap.className = "root";
    const top = doc.createElement("div");
    top.className = "top";
    const text = doc.createElement("span");
    text.textContent = resume ? `Select the video to resume: ${resume.resumeTitle ?? ""}`.trimEnd() : "Pick a video on this page";
    const cancelBtn = doc.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel · Esc";
    cancelBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      cancel();
    });
    top.append(text, cancelBtn);
    wrap.append(top);
    root.append(style, wrap);
    layer = wrap;
    (doc.documentElement ?? doc.body).append(host);

    doc.addEventListener("mousemove", onMove, true);
    doc.addEventListener("click", onClick, true);
    for (const t of SWALLOWED) doc.addEventListener(t, onSwallow, true);
    doc.addEventListener("keydown", onKey, true);
    win.addEventListener("scroll", onLayout, true);
    win.addEventListener("resize", onLayout);
  }

  function cancel() {
    if (!host) return;
    doc.removeEventListener("mousemove", onMove, true);
    doc.removeEventListener("click", onClick, true);
    for (const t of SWALLOWED) doc.removeEventListener(t, onSwallow, true);
    doc.removeEventListener("keydown", onKey, true);
    win.removeEventListener("scroll", onLayout, true);
    win.removeEventListener("resize", onLayout);
    host.remove();
    host = undefined;
    root = layer = undefined;
    hovered = selected = undefined;
    focusIndex = -1;
    resume = undefined;
  }

  return {
    start,
    cancel,
    get active() {
      return host !== undefined;
    },
  };
}
