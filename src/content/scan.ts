/** DOM scan: read <video> facts, let the page's adapter turn them into sources. */
import { pickAdapter } from "../adapters/registry";
import type { DomVideo } from "../adapters/types";
import type { VideoSource } from "../core/model";

function visibleRatio(r: DOMRect): number {
  const area = r.width * r.height;
  if (area <= 0) return 0;
  const w = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0));
  const h = Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
  return (w * h) / area;
}

export function readVideos(doc: Document): DomVideo[] {
  return [...doc.querySelectorAll("video")].map((el, i) => {
    const r = el.getBoundingClientRect();
    return {
      elementKey: `v${i}`,
      frameId: 0,
      src: el.currentSrc || el.src,
      ...(el.poster ? { poster: el.poster } : {}),
      ...(Number.isFinite(el.duration) ? { duration: el.duration } : {}),
      rectWidth: r.width,
      rectHeight: r.height,
      visibleRatio: visibleRatio(r),
      playing: !el.paused && !el.ended,
      ...(el.videoHeight ? { videoWidth: el.videoWidth, videoHeight: el.videoHeight } : {}),
    };
  });
}

export function scanDocument(doc: Document, pageUrl: string): VideoSource[] {
  return pickAdapter(pageUrl).detect({ pageUrl, pageTitle: doc.title, domVideos: readVideos(doc), network: [] });
}
