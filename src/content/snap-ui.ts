/**
 * In-page snap UI: shutter flash, toast, and the floating on-video button.
 * Each lives in its own shadow root so page CSS cannot touch it. The flash is
 * skipped under prefers-reduced-motion.
 */
import type { DomDetector } from './dom-detect';
import type { SnapUi } from './snap';

interface UiOptions {
  document: Document;
  /** Tests use "open" so the shadow content can be inspected. */
  shadowMode?: 'open' | 'closed';
  reducedMotion?: () => boolean;
}

const FLASH_MS = 300;
const TOAST_MS = 6000;

const CSS = `
:host { all: initial; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; font: 500 13px/1.3 Inter, system-ui, sans-serif; }
.flash { position: absolute; inset: 0; background: #fff; opacity: 0; animation: flash ${FLASH_MS}ms ease-out; }
@keyframes flash { 0% { opacity: 0.7; } 100% { opacity: 0; } }
.toast { position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%); display: flex; gap: 12px; align-items: center;
  padding: 10px 16px; background: #1d1b17; color: #faf8f3; border-radius: 8px; pointer-events: auto; max-width: 80vw; }
.toast button { font: inherit; cursor: pointer; background: #c23a08; color: #faf8f3; border: 0; border-radius: 6px; padding: 4px 10px; }
button:focus-visible { outline: 2px solid #faf8f3; outline-offset: 2px; }
`;

export function createSnapUi(o: UiOptions): SnapUi {
  const { document: doc, shadowMode = 'closed' } = o;
  const reduced =
    o.reducedMotion ??
    (() => doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true);
  let layer: HTMLElement | undefined;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function ensure(): HTMLElement {
    if (layer?.isConnected) return layer;
    const host = doc.createElement('div');
    host.setAttribute('data-framesnap-snap', '');
    const root = host.attachShadow({ mode: shadowMode });
    const style = doc.createElement('style');
    style.textContent = CSS;
    layer = doc.createElement('div');
    layer.className = 'layer';
    root.append(style, layer);
    (doc.documentElement ?? doc.body).append(host);
    return layer;
  }

  return {
    flash() {
      if (reduced()) return;
      const el = doc.createElement('div');
      el.className = 'flash';
      ensure().append(el);
      setTimeout(() => el.remove(), FLASH_MS);
    },
    toast(text, action) {
      const l = ensure();
      l.querySelector('.toast')?.remove();
      if (toastTimer) clearTimeout(toastTimer);
      const el = doc.createElement('div');
      el.className = 'toast';
      el.setAttribute('role', 'status');
      const span = doc.createElement('span');
      span.textContent = text;
      el.append(span);
      if (action) {
        const b = doc.createElement('button');
        b.type = 'button';
        b.textContent = action.label;
        b.addEventListener('click', () => void action.onClick());
        el.append(b);
      }
      l.append(el);
      toastTimer = setTimeout(() => el.remove(), TOAST_MS);
    },
  };
}

export interface SnapButtonOptions {
  document: Document;
  detector: DomDetector;
  onSnap(elementKey: string): void;
  shadowMode?: 'open' | 'closed';
  enabled: boolean;
}

export interface SnapButton {
  setEnabled(enabled: boolean): void;
  destroy(): void;
}

const BTN_CSS = `
:host { all: initial; }
button { position: fixed; z-index: 2147483647; width: 36px; height: 36px; border-radius: 8px; border: 0; cursor: pointer;
  background: #c23a08; color: #faf8f3; font: 600 16px/1 system-ui, sans-serif; box-shadow: 0 1px 4px #0006;
  opacity: 0; transition: opacity 120ms ease-out; }
/* Placed over the video's corner but invisible until the pointer is on the button itself. */
button:hover, button:focus-visible { opacity: 1; }
button:focus-visible { outline: 2px solid #faf8f3; outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { button { transition: none; } }
`;
const HIDE_DELAY_MS = 1500;

export function createSnapButton(o: SnapButtonOptions): SnapButton {
  const { document: doc, detector, shadowMode = 'closed' } = o;
  let enabled = o.enabled;
  let host: HTMLElement | undefined;
  let shownFor: HTMLVideoElement | undefined;
  let btn: HTMLButtonElement | undefined;

  const place = (b: HTMLButtonElement, video: HTMLVideoElement) => {
    const r = video.getBoundingClientRect();
    b.style.left = `${Math.max(0, r.right - 44)}px`;
    b.style.top = `${Math.max(0, r.top + 8)}px`;
  };
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const keyOf = (video: HTMLVideoElement) =>
    detector.scan().find((s) => s.frameRef && detector.resolve(s.frameRef.elementKey) === video)
      ?.frameRef?.elementKey;

  function hide() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = undefined;
    host?.remove();
    host = undefined;
    shownFor = undefined;
    btn = undefined;
  }

  function show(video: HTMLVideoElement, key: string) {
    // Already placed on this video: keep it, so a hovered button is not rebuilt under the pointer.
    if (host && btn && shownFor === video) {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = undefined;
      place(btn, video);
      return;
    }
    hide();
    shownFor = video;
    host = doc.createElement('div');
    host.setAttribute('data-framesnap-snapbtn', '');
    const root = host.attachShadow({ mode: shadowMode });
    const style = doc.createElement('style');
    style.textContent = BTN_CSS;
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = '▣';
    b.setAttribute('aria-label', 'Snap this frame');
    b.title = 'Snap this frame';
    place(b, video);
    btn = b;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      o.onSnap(key);
    });
    root.append(style, b);
    (doc.documentElement ?? doc.body).append(host);
  }

  const onOver = (e: Event) => {
    if (!enabled) return;
    const path = e.composedPath();
    if (host && path.includes(host)) {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = undefined;
      return;
    }
    const VideoCtor = doc.defaultView!.HTMLVideoElement;
    const video = path.find((n): n is HTMLVideoElement => n instanceof VideoCtor);
    const key = video && keyOf(video);
    if (video && key) show(video, key);
    else if (host && !hideTimer) hideTimer = setTimeout(hide, HIDE_DELAY_MS);
  };
  doc.addEventListener('mouseover', onOver, true);

  return {
    setEnabled(next) {
      enabled = next;
      if (!enabled) hide();
    },
    destroy() {
      doc.removeEventListener('mouseover', onOver, true);
      hide();
    },
  };
}
