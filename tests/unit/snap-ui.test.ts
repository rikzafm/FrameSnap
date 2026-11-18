// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDomDetector } from '../../src/content/dom-detect';
import { createSnapButton, createSnapUi } from '../../src/content/snap-ui';

const shadow = (sel: string) => document.querySelector<HTMLElement>(sel)!.shadowRoot!;

beforeEach(() => {
  document.body.innerHTML = '';
  document
    .querySelectorAll('[data-framesnap-snap], [data-framesnap-snapbtn]')
    .forEach((n) => n.remove());
  HTMLCanvasElement.prototype.getContext = () => null;
  vi.useFakeTimers();
});
const buttons: { destroy(): void }[] = [];
afterEach(() => {
  vi.useRealTimers();
  buttons.splice(0).forEach((b) => b.destroy());
});

describe('shutter flash and toast', () => {
  it('flashes briefly and removes itself', () => {
    const ui = createSnapUi({ document, shadowMode: 'open', reducedMotion: () => false });
    ui.flash();
    expect(shadow('[data-framesnap-snap]').querySelector('.flash')).not.toBeNull();
    vi.advanceTimersByTime(400);
    expect(shadow('[data-framesnap-snap]').querySelector('.flash')).toBeNull();
  });

  it('skips the animation for reduced motion', () => {
    const ui = createSnapUi({ document, shadowMode: 'open', reducedMotion: () => true });
    ui.flash();
    expect(
      document.querySelector('[data-framesnap-snap]')?.shadowRoot?.querySelector('.flash') ?? null,
    ).toBeNull();
  });

  it('shows a polite toast with an optional action, then clears it', () => {
    const ui = createSnapUi({ document, shadowMode: 'open', reducedMotion: () => false });
    const onClick = vi.fn();
    ui.toast('Could not copy automatically.', { label: 'Copy', onClick });
    const root = shadow('[data-framesnap-snap]');
    expect(root.querySelector('.toast')!.getAttribute('role')).toBe('status');
    root.querySelector<HTMLButtonElement>('.toast button')!.click();
    expect(onClick).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(7000);
    expect(root.querySelector('.toast')).toBeNull();
  });
});

describe('on-video Snap button', () => {
  function setup(enabled = true) {
    const v = document.createElement('video');
    v.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 100,
        top: 50,
        right: 740,
        bottom: 410,
        width: 640,
        height: 360,
      }) as DOMRect;
    Object.defineProperty(v, 'currentSrc', { value: 'https://cdn.test/a.mp4' });
    document.body.append(v);
    const detector = createDomDetector({
      document,
      frameUrl: 'https://page.test/',
      emit: () => {},
    });
    const onSnap = vi.fn();
    const btn = createSnapButton({ document, detector, onSnap, shadowMode: 'open', enabled });
    buttons.push(btn);
    const key = detector.scan()[0]!.frameRef!.elementKey;
    return { v, btn, onSnap, key };
  }
  const label = () =>
    document
      .querySelector('[data-framesnap-snapbtn]')
      ?.shadowRoot?.querySelector<HTMLButtonElement>('button') ?? null;

  it('appears over a hovered video and snaps that video', () => {
    const { v, onSnap, key } = setup();
    v.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));
    expect(label()).not.toBeNull();
    expect(label()!.getAttribute('aria-label')).toBe('Snap this frame');
    label()!.click();
    expect(onSnap).toHaveBeenCalledWith(key);
  });

  it('hides shortly after the pointer leaves', () => {
    const { v } = setup();
    v.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));
    document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));
    vi.advanceTimersByTime(2000);
    expect(label()).toBeNull();
  });

  it('stays away when turned off, and goes when turned off while showing', () => {
    const off = setup(false);
    off.v.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));
    expect(label()).toBeNull();
    off.btn.setEnabled(true);
    off.v.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, composed: true }));
    expect(label()).not.toBeNull();
    off.btn.setEnabled(false);
    expect(label()).toBeNull();
  });
});
