import { createDomDetector } from "../../src/content/dom-detect";
import type { VideoSource } from "../../src/core/model";

/**
 * A page whose <video> has Encrypted Media Extensions attached (`mediaKeys` set), the signal real
 * DRM players leave in the DOM. Returns the source the DOM detector reports for it.
 */
export function fakeEmePage(pageUrl = "https://example.com/watch"): VideoSource {
  document.body.innerHTML = "";
  const v = document.createElement("video");
  Object.defineProperty(v, "currentSrc", { value: "blob:https://example.com/eme", configurable: true });
  Object.defineProperty(v, "mediaKeys", { value: {}, configurable: true });
  v.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 320, bottom: 180, width: 320, height: 180 }) as DOMRect;
  document.body.append(v);
  return createDomDetector({ document, frameUrl: pageUrl, emit: () => {} }).scan()[0]!;
}
