// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDomDetector } from "../../src/content/dom-detect";
import { createPicker } from "../../src/content/picker";
import { handleWorkerMessage } from "../../src/content/handler";
import type { ContentToWorker } from "../../src/core/messages";

const PAGE = "https://page.test/";

function stubVideo(v: HTMLVideoElement, o: { left: number; top: number; w: number; h: number; src: string }) {
  v.getBoundingClientRect = () =>
    ({ x: o.left, y: o.top, left: o.left, top: o.top, right: o.left + o.w, bottom: o.top + o.h, width: o.w, height: o.h }) as DOMRect;
  Object.defineProperty(v, "currentSrc", { value: o.src, configurable: true });
  return v;
}

const live: { cancel(): void }[] = [];

function setup() {
  document.body.innerHTML = "";
  const a = stubVideo(document.createElement("video"), { left: 0, top: 0, w: 320, h: 180, src: "https://cdn.test/a.mp4" });
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  const b = stubVideo(document.createElement("video"), { left: 400, top: 0, w: 200, h: 100, src: "https://cdn.test/b.mp4" });
  shadow.append(b);
  document.body.append(a, host);

  // jsdom has no layout: hit-test by rectangle.
  const hit = (x: number, y: number, v: HTMLVideoElement) => {
    const r = v.getBoundingClientRect();
    return x >= r.left && x < r.right && y >= r.top && y < r.bottom;
  };
  document.elementsFromPoint = (x, y) => (hit(x, y, a) ? [a, document.body] : hit(x, y, b) ? [host, document.body] : [document.body]);
  shadow.elementsFromPoint = (x, y) => (hit(x, y, b) ? [b] : []);

  const sent: ContentToWorker[] = [];
  const detector = createDomDetector({ document, frameUrl: PAGE, emit: () => {} });
  const picker = createPicker({ document, detector, send: (m) => sent.push(m), shadowMode: "open" });
  live.push(picker);
  const root = () => document.querySelector<HTMLElement>("[data-framesnap-picker]")!.shadowRoot!;
  return { a, b, detector, picker, sent, root };
}

function move(x: number, y: number) {
  document.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }));
}
function click(target: Element, x: number, y: number) {
  target.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true }));
}
const key = (k: string) => document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));

afterEach(() => {
  for (const p of live.splice(0)) p.cancel();
  document.body.innerHTML = "";
});

describe("picker", () => {
  it("shows the ink top bar and no overlay until started", () => {
    const { picker, root } = setup();
    expect(document.querySelector("[data-framesnap-picker]")).toBeNull();
    picker.start({});
    expect(root().textContent).toContain("Pick a video on this page");
    expect(root().textContent).toContain("Cancel");
    expect(root().textContent).toContain("Esc");
  });

  it("outlines a hovered video with its size, including inside shadow DOM", () => {
    const { picker, root } = setup();
    picker.start({});
    move(10, 10);
    expect(root().textContent).toContain("Click to select · 320×180");
    move(410, 10);
    expect(root().textContent).toContain("Click to select · 200×100");
    move(900, 900);
    expect(root().textContent).not.toContain("Click to select");
  });

  it("picking each video yields the same source id as the list, then shows the action bar", () => {
    const { a, b, detector, picker, sent, root } = setup();
    const listed = detector.scan();
    picker.start({});
    click(a, 10, 10);
    const picked = sent.find((m) => m.t === "picker/picked");
    expect(picked && picked.t === "picker/picked" && picked.source).toEqual(listed.find((s) => detector.resolve(s.frameRef!.elementKey) === a));
    expect(root().textContent).toContain("Selected · 320×180");
    for (const label of ["Download MP4", "GIF", "Snap frame"]) expect(root().textContent).toContain(label);

    sent.length = 0;
    click(document.body.querySelector("div")!, 410, 10);
    const second = sent[0];
    expect(second && second.t === "picker/picked" && second.source.id).toBe(listed.find((s) => detector.resolve(s.frameRef!.elementKey) === b)!.id);
  });

  it("swallows page clicks while picking and restores them after cancel", () => {
    const { a, picker } = setup();
    const pageHandler = vi.fn();
    a.addEventListener("click", pageHandler);
    picker.start({});
    click(a, 10, 10);
    expect(pageHandler).not.toHaveBeenCalled();
    picker.cancel();
    click(a, 10, 10);
    expect(pageHandler).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-framesnap-picker]")).toBeNull();
  });

  it("Esc cancels", () => {
    const { a, picker } = setup();
    const pageHandler = vi.fn();
    a.addEventListener("click", pageHandler);
    picker.start({});
    key("Escape");
    click(a, 10, 10);
    expect(pageHandler).toHaveBeenCalledTimes(1);
  });

  it("Tab cycles videos and Enter selects the focused one", () => {
    const { detector, picker, sent, root } = setup();
    const listed = detector.scan();
    picker.start({});
    key("Tab");
    expect(root().textContent).toContain("320×180");
    key("Tab");
    expect(root().textContent).toContain("200×100");
    key("Enter");
    const picked = sent.find((m) => m.t === "picker/picked");
    expect(picked && picked.t === "picker/picked" && picked.source.id).toBe(listed[1]!.id);
    expect(root().textContent).toContain("Selected · 200×100");
  });

  it("outlines follow scroll and resize", () => {
    const { a, picker, root } = setup();
    picker.start({});
    move(10, 10);
    const outline = () => root().querySelector<HTMLElement>("[data-outline]")!;
    expect(outline().style.left).toBe("0px");
    a.getBoundingClientRect = () => ({ left: 0, top: -50, right: 320, bottom: 130, width: 320, height: 180, x: 0, y: -50 }) as DOMRect;
    window.dispatchEvent(new Event("scroll"));
    expect(outline().style.top).toBe("-50px");
  });

  it("GIF and Snap buttons send picker/action for the selected source", () => {
    const { a, picker, sent, root } = setup();
    picker.start({});
    click(a, 10, 10);
    sent.length = 0;
    root().querySelector<HTMLElement>("[data-action=gif]")!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: "picker/action", action: "gif" });
    expect(picker.active).toBe(false);
    picker.start({});
    click(a, 10, 10);
    root().querySelector<HTMLElement>("[data-action=snap]")!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    expect(sent.at(-1)).toMatchObject({ t: "picker/action", action: "snap" });
  });

  it("resume mode names the job, and the pick carries the job id and closes the picker", () => {
    const { a, picker, sent, root } = setup();
    picker.start({ resumeJobId: "job1", resumeTitle: "My clip" });
    expect(root().textContent).toContain("Select the video to resume: My clip");
    click(a, 10, 10);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ t: "picker/picked", resumeJobId: "job1" });
    expect(document.querySelector("[data-framesnap-picker]")).toBeNull();
  });

  it("is driven by worker messages and ignores a start when the frame has no video", () => {
    const { detector, picker } = setup();
    handleWorkerMessage({ t: "picker/start" }, detector, PAGE, picker);
    expect(document.querySelector("[data-framesnap-picker]")).not.toBeNull();
    handleWorkerMessage({ t: "picker/cancel" }, detector, PAGE, picker);
    expect(document.querySelector("[data-framesnap-picker]")).toBeNull();
    document.body.innerHTML = "";
    handleWorkerMessage({ t: "picker/start" }, detector, PAGE, picker);
    expect(document.querySelector("[data-framesnap-picker]")).toBeNull();
  });
});
