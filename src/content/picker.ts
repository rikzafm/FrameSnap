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
import type { OutputFormat, VideoSource } from "../core/model";
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
.root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font: 500 14px/1.3 Inter, system-ui, sans-serif; }
.top { position: absolute; top: 16px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 14px;
  max-width: calc(100vw - 24px); padding: 10px 10px 10px 24px; background: #1d1b17; color: #faf8f3; border-radius: 999px; pointer-events: auto;
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.28); white-space: nowrap; }
.top .icon { display: inline-flex; width: 20px; height: 20px; }
.top strong { font-size: 16px; font-weight: 700; }
.top .hint { color: #cfc9b9; font-size: 16px; font-weight: 400; overflow: hidden; text-overflow: ellipsis; }
.top button, .bar button { font: inherit; cursor: pointer; }
.top button { background: transparent; color: #faf8f3; border: 1.5px solid #6b655a; border-radius: 999px; padding: 9px 20px; font-size: 16px; font-weight: 600; }
.outline { position: absolute; box-sizing: border-box; border: 2px dashed #1d1b17; border-radius: 12px; }
.outline.selected { border: 3px solid #c23a08; border-radius: 10px; }
.tag { position: absolute; left: -2px; top: calc(100% + 8px); padding: 4px 12px; background: #faf8f3; color: #1d1b17;
  border: 1.5px solid #d6cfbf; border-radius: 8px; white-space: nowrap; font-size: 14px; }
.outline.selected .tag { left: -3px; top: auto; bottom: calc(100% + 8px); padding: 4px 14px; background: #c23a08; color: #faf8f3; border: 0; border-radius: 6px; font-weight: 700; }
.bar { position: absolute; display: flex; align-items: stretch; gap: 8px; padding: 8px; background: #1d1b17; border-radius: 16px; pointer-events: auto;
  box-sizing: border-box; min-width: 410px; max-width: calc(100vw - 16px); flex-wrap: wrap; }
.bar button { min-height: 44px; background: #faf8f3; color: #1d1b17; border: 0; border-radius: 10px; padding: 0 18px; font-size: 16px; font-weight: 700; white-space: nowrap; }
.bar .split { flex: 1; display: flex; justify-content: center; align-items: stretch; background: #c23a08; border-radius: 10px; min-width: 190px; }
.bar .split button { background: transparent; color: #faf8f3; border-radius: 10px; padding: 0 6px; font-size: 17px; }
.bar .split button.main { padding-left: 14px; }
.bar .split button.caret { padding-right: 14px; font-size: 15px; }
.bar .split.disabled { opacity: 0.45; }
.bar button:disabled { opacity: 0.45; cursor: not-allowed; }
.bar .note { flex-basis: 100%; margin: 0; color: #faf8f3; }
.menu { position: absolute; left: 8px; bottom: calc(100% + 8px); min-width: 180px; display: flex; flex-direction: column; padding: 6px;
  background: #1d1b17; border-radius: 12px; box-shadow: 0 6px 24px rgb(0 0 0 / 0.28); }
.bar .menu button { min-height: 36px; flex: none; align-items: center; display: flex; justify-content: space-between; gap: 16px; background: transparent; color: #faf8f3; padding: 0 12px; font-weight: 500; text-align: left; }
.bar .menu button[aria-checked="true"] { background: #c23a08; font-weight: 700; }
button:focus-visible { outline: 2px solid #faf8f3; outline-offset: 2px; }
`;

const FORMAT_CHOICES: [OutputFormat, string][] = [
  ["mp4", "MP4"],
  ["webm", "WebM"],
  ["mkv", "MKV"],
  ["mov", "MOV"],
  ["mp3", "MP3 (audio)"],
  ["m4a", "M4A (audio)"],
];
const CURSOR_ICON =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#faf8f3" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M4 3l16 7-7 2.5L10 20z"/></svg>';

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
  /** Format shown on the Download button and sent with it. */
  let format: OutputFormat = "mp4";
  let menuOpen = false;

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
    tag.dataset.tag = kind;
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
    const left = Math.max(8, r.left);
    bar.style.left = `${left}px`;
    bar.style.top = `${Math.max(72, r.bottom + 12)}px`;
    bar.style.width = `${Math.max(410, Math.min(r.width, win.innerWidth - left - 8))}px`;
    const buttons: [PickerAction, string, boolean][] = [
      ["download", `Download ${format.toUpperCase()}`, true],
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
      if (primary) b.className = "main";
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        menuOpen = false;
        if (selected) send({ t: "picker/action", action, source: selected.source, ...(action === "download" ? { format } : {}) });
        if (action !== "download") cancel();
        else render();
      });
      if (!primary) {
        bar.append(b);
        continue;
      }
      // Download and its caret share one accent block, like a single button
      const split = doc.createElement("div");
      split.className = locked ? "split disabled" : "split";
      const caret = doc.createElement("button");
      caret.type = "button";
      caret.className = "caret";
      caret.textContent = "\u25BE";
      caret.disabled = locked;
      caret.setAttribute("aria-label", "Choose format");
      caret.setAttribute("aria-haspopup", "menu");
      caret.setAttribute("aria-expanded", String(menuOpen));
      caret.addEventListener("click", (ev) => {
        ev.stopPropagation();
        menuOpen = !menuOpen;
        render();
      });
      split.append(b, caret);
      bar.append(split);
    }
    if (menuOpen && !locked) {
      const menu = doc.createElement("div");
      menu.className = "menu";
      // open upwards unless that would run off the top of the viewport
      if (Math.max(72, r.bottom + 12) < FORMAT_CHOICES.length * 36 + 40) {
        menu.style.bottom = "auto";
        menu.style.top = "calc(100% + 8px)";
      }
      menu.setAttribute("role", "menu");
      for (const [value, label] of FORMAT_CHOICES) {
        const item = doc.createElement("button");
        item.type = "button";
        item.setAttribute("role", "menuitemradio");
        item.setAttribute("aria-checked", String(value === format));
        item.dataset.format = value;
        item.textContent = label;
        item.addEventListener("click", (ev) => {
          ev.stopPropagation();
          format = value;
          menuOpen = false;
          if (selected) send({ t: "picker/action", action: "download", source: selected.source, format });
          render();
        });
        menu.append(item);
      }
      bar.append(menu);
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
      if (menuOpen) {
        menuOpen = false;
        render();
        return;
      }
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
    const icon = doc.createElement("span");
    icon.className = "icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = CURSOR_ICON;
    const brand = doc.createElement("strong");
    brand.textContent = "Frame Snap";
    const text = doc.createElement("span");
    text.className = "hint";
    text.textContent = resume ? `Select the video to resume: ${resume.resumeTitle ?? ""}`.trimEnd() : "Pick a video on this page";
    const cancelBtn = doc.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel · Esc";
    cancelBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      cancel();
    });
    top.append(icon, brand, text, cancelBtn);
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
    menuOpen = false;
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
