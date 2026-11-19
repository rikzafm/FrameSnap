// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDomDetector } from "../../src/content/dom-detect";
import { handleWorkerMessage } from "../../src/content/handler";
import { isContentToWorker } from "../../src/core/messages";
import type { VideoSource } from "../../src/core/model";
import { buildManifest } from "../../src/manifest";

function stubVideo(v: HTMLVideoElement, o: { w?: number; h?: number; duration?: number; src?: string } = {}) {
  v.getBoundingClientRect = () =>
    ({ x: 0, y: 0, left: 0, top: 0, right: o.w ?? 320, bottom: o.h ?? 180, width: o.w ?? 320, height: o.h ?? 180 }) as DOMRect;
  if (o.duration !== undefined) Object.defineProperty(v, "duration", { value: o.duration, configurable: true });
  if (o.src !== undefined) Object.defineProperty(v, "currentSrc", { value: o.src, configurable: true });
  return v;
}

function fixture() {
  document.body.innerHTML = "";
  const top = stubVideo(document.createElement("video"), { src: "https://cdn.test/a.mp4", duration: 12 });
  top.poster = "https://cdn.test/a.jpg";
  document.body.append(top);

  const host = document.createElement("div");
  document.body.append(host);
  const shadow = host.attachShadow({ mode: "open" });
  const inner = stubVideo(document.createElement("video"), { src: "https://cdn.test/b.mp4" });
  shadow.append(inner);

  const frame = document.createElement("iframe");
  document.body.append(frame);
  const fdoc = frame.contentDocument!;
  const fv = stubVideo(fdoc.createElement("video"), { src: "https://cdn.test/c.mp4" });
  fdoc.body.append(fv);
  return { top, inner, fv, frame };
}

const PAGE = "https://page.test/";

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("dom detector", () => {
  it("reports a source with dom facts, id, frameRef, duration, poster and progressive variant", () => {
    document.body.innerHTML = "";
    const v = stubVideo(document.createElement("video"), { src: "https://cdn.test/a.mp4", duration: 12 });
    v.poster = "https://cdn.test/a.jpg";
    document.body.append(v);
    const d = createDomDetector({ document, frameUrl: PAGE, emit: () => {} });
    const s = d.scan()[0]!;
    expect(s.id).toMatch(/^dom:[0-9a-f]{8}$/);
    expect(s.detectedBy).toEqual(["dom"]);
    expect(s.protection).toBe("none");
    expect(s.duration).toBe(12);
    expect(s.thumbnail).toBe("https://cdn.test/a.jpg");
    expect(s.dom).toMatchObject({ rectWidth: 320, rectHeight: 180, playing: false });
    expect(s.frameRef?.elementKey).toBeTruthy();
    expect(s.variants).toHaveLength(1);
    expect(s.variants[0]).toMatchObject({ kind: "progressive", url: "https://cdn.test/a.mp4", container: "mp4" });
    expect(isContentToWorker({ t: "dom/report", sources: [s], frameUrl: PAGE })).toBe(true);
  });

  it("reports a GIF image as a source whose one variant is the original .gif", () => {
    document.body.innerHTML = "";
    const img = document.createElement("img");
    img.src = "https://cdn.test/media/dancing%20cat.gif?w=1";
    Object.defineProperty(img, "naturalWidth", { value: 480 });
    Object.defineProperty(img, "naturalHeight", { value: 270 });
    img.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 480, bottom: 270, width: 480, height: 270 }) as DOMRect;
    const twin = img.cloneNode() as HTMLImageElement;
    Object.defineProperty(twin, "naturalWidth", { value: 480 });
    Object.defineProperty(twin, "naturalHeight", { value: 270 });
    const pixel = document.createElement("img");
    pixel.src = "https://cdn.test/t.gif";
    Object.defineProperty(pixel, "naturalWidth", { value: 1 });
    Object.defineProperty(pixel, "naturalHeight", { value: 1 });
    const still = document.createElement("img");
    still.src = "https://cdn.test/photo.jpg";
    document.body.append(img, twin, pixel, still);
    const sources = createDomDetector({ document, frameUrl: PAGE, emit: () => {} }).scan();
    expect(sources).toHaveLength(1);
    const s = sources[0]!;
    expect(s.id).toMatch(/^gif:[0-9a-f]{8}$/);
    expect(s.title).toBe("dancing cat");
    expect(s.frameRef).toBeUndefined();
    expect(s.variants).toEqual([expect.objectContaining({ url: "https://cdn.test/media/dancing%20cat.gif?w=1", container: "gif", width: 480, height: 270, hasAudio: false })]);
    expect(isContentToWorker({ t: "dom/report", sources: [s], frameUrl: PAGE })).toBe(true);
  });

  it("points a Reddit GIF played as MP4 at its original .gif", () => {
    document.body.innerHTML = "";
    const v = stubVideo(document.createElement("video"), { src: "https://preview.redd.it/cat-v0-abc123.gif?format=mp4&s=f00", duration: 4 });
    document.body.append(v);
    const s = createDomDetector({ document, frameUrl: PAGE, emit: () => {} }).scan()[0]!;
    expect(s.gifUrl).toBe("https://i.redd.it/abc123.gif");
    expect(s.animatedGif).toBe(true);
    expect(s.variants[0]).toMatchObject({ container: "mp4", hasAudio: false });
  });

  it("reports a Reddit GIF's still preview as the original GIF, and ignores other stills named .gif", () => {
    document.body.innerHTML = "";
    const size = (img: HTMLImageElement) => {
      Object.defineProperty(img, "naturalWidth", { value: 320 });
      Object.defineProperty(img, "naturalHeight", { value: 240 });
      return img;
    };
    const reddit = size(document.createElement("img"));
    reddit.src = "https://preview.redd.it/abc123.gif?width=320&format=png8&s=1";
    const other = size(document.createElement("img"));
    other.src = "https://cdn.test/thumb.gif?format=jpg";
    document.body.append(reddit, other);
    const sources = createDomDetector({ document, frameUrl: PAGE, emit: () => {} }).scan();
    expect(sources.map((s) => s.variants[0]!.url)).toEqual(["https://i.redd.it/abc123.gif"]);
  });

  it("reports the page URL as it is now, after a single-page navigation", () => {
    document.body.innerHTML = "";
    document.body.append(stubVideo(document.createElement("video"), { src: "https://cdn.test/a.mp4" }));
    let url = "https://www.youtube.com/results?search_query=x";
    const d = createDomDetector({ document, frameUrl: () => url, emit: () => {} });
    expect(d.scan()[0]!.pageUrl).toBe(url);
    url = "https://www.youtube.com/watch?v=abcdefghijk";
    expect(d.scan()[0]!.pageUrl).toBe("https://www.youtube.com/watch?v=abcdefghijk");
    expect(handleWorkerMessage({ t: "dom/scan" }, d, () => url)).toMatchObject({ frameUrl: url });
  });

  it("reports the playhead so the GIF tab can start there", () => {
    document.body.innerHTML = "";
    const v = stubVideo(document.createElement("video"), { src: "https://cdn.test/a.mp4", duration: 60 });
    v.currentTime = 12.5;
    document.body.append(v);
    const d = createDomDetector({ document, frameUrl: PAGE, emit: () => {} });
    expect(d.scan()[0]!.dom).toMatchObject({ currentTime: 12.5 });
  });

  it("keeps ids and element keys stable across scans", () => {
    const { top } = fixture();
    const d = createDomDetector({ document, frameUrl: PAGE, emit: () => {} });
    const a = d.scan().find((s) => s.variants[0]?.url.endsWith("a.mp4"))!;
    const b = d.scan().find((s) => s.variants[0]?.url.endsWith("a.mp4"))!;
    expect(b.id).toBe(a.id);
    expect(b.frameRef).toEqual(a.frameRef);
    expect(d.resolve(a.frameRef!.elementKey)).toBe(top);
  });

  it("finds videos in open shadow roots; same-origin iframes are covered by their own detector", () => {
    const { frame } = fixture();
    const top = createDomDetector({ document, frameUrl: PAGE, emit: () => {} }).scan();
    const inFrame = createDomDetector({ document: frame.contentDocument!, frameUrl: "about:blank", emit: () => {} }).scan();
    expect([...top, ...inFrame]).toHaveLength(3);
    expect(top.map((s) => s.variants[0]?.url).sort()).toEqual(["https://cdn.test/a.mp4", "https://cdn.test/b.mp4"]);
  });

  it("marks DRM video and offers no variant for blob: sources", () => {
    document.body.innerHTML = "";
    const v = stubVideo(document.createElement("video"), { src: "blob:https://page.test/xyz" });
    Object.defineProperty(v, "mediaKeys", { value: {}, configurable: true });
    document.body.append(v);
    const s = createDomDetector({ document, frameUrl: PAGE, emit: () => {} }).scan()[0]!;
    expect(s.protection).toBe("drm");
    expect(s.variants).toEqual([]);
  });

  it("computes the visible ratio against the viewport", () => {
    document.body.innerHTML = "";
    const v = stubVideo(document.createElement("video"), { src: "https://cdn.test/a.mp4" });
    v.getBoundingClientRect = () =>
      ({ left: 0, top: window.innerHeight - 90, right: 320, bottom: window.innerHeight + 90, width: 320, height: 180 }) as DOMRect;
    document.body.append(v);
    const s = createDomDetector({ document, frameUrl: PAGE, emit: () => {} }).scan()[0]!;
    expect(s.dom?.visibleRatio).toBeCloseTo(0.5, 2);
  });

  it("reports a video added by script within 300 ms", async () => {
    vi.useFakeTimers();
    fixture();
    const reports: VideoSource[][] = [];
    const d = createDomDetector({ document, frameUrl: PAGE, emit: (s) => reports.push(s) });
    d.start();
    expect(reports.at(-1)).toHaveLength(2);
    document.body.append(stubVideo(document.createElement("video"), { src: "https://cdn.test/d.mp4" }));
    await vi.advanceTimersByTimeAsync(300);
    expect(reports.at(-1)).toHaveLength(3);
    d.stop();
  });

  it("re-reports on play and picks up videos added inside a shadow root later", async () => {
    vi.useFakeTimers();
    const { inner } = fixture();
    const reports: VideoSource[][] = [];
    const d = createDomDetector({ document, frameUrl: PAGE, emit: (s) => reports.push(s) });
    d.start();
    const n = reports.length;
    Object.defineProperty(inner, "paused", { value: false, configurable: true });
    Object.defineProperty(inner, "readyState", { value: 4, configurable: true });
    inner.dispatchEvent(new Event("play"));
    await vi.advanceTimersByTimeAsync(300);
    expect(reports.length).toBeGreaterThan(n);
    inner.parentNode!.appendChild(stubVideo(document.createElement("video"), { src: "https://cdn.test/e.mp4" }));
    await vi.advanceTimersByTimeAsync(300);
    expect(reports.at(-1)).toHaveLength(3);
    d.stop();
  });
});

describe("content message handling", () => {
  it("answers a dom/scan request with a dom/report within 150 ms", () => {
    fixture();
    const d = createDomDetector({ document, frameUrl: PAGE, emit: () => {} });
    const t0 = performance.now();
    const reply = handleWorkerMessage({ t: "dom/scan" }, d, PAGE);
    expect(performance.now() - t0).toBeLessThan(150);
    expect(reply).toMatchObject({ t: "dom/report", frameUrl: PAGE });
    expect(isContentToWorker(reply)).toBe(true);
  });

  it("still answers the demo ping", () => {
    const d = createDomDetector({ document, frameUrl: PAGE, emit: () => {} });
    expect(handleWorkerMessage({ t: "demo/ping", nonce: "n" }, d, PAGE)).toMatchObject({ t: "demo/pong", nonce: "n" });
  });
});

describe("manifest", () => {
  it("runs the content script in every frame, including about:blank children", () => {
    const cs = buildManifest().content_scripts[0] as Record<string, unknown>;
    expect(cs.all_frames).toBe(true);
    expect(cs.match_origin_as_fallback).toBe(true);
  });
});
