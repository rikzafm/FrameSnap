/**
 * Minimal <video> extraction from an HTML string, for contexts without a DOM
 * (service worker, tests). The content script reads the live DOM instead.
 */
import type { DomVideo } from "./types";

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[1] ?? m[2]) : undefined;
};

function absolute(url: string | undefined, base: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url, base).toString();
  } catch {
    return undefined;
  }
}

export function domVideosFromHtml(html: string, pageUrl: string): DomVideo[] {
  const out: DomVideo[] = [];
  const re = /<video\b([^>]*)>([\s\S]*?)<\/video>|<video\b([^>]*)\/?>/gi;
  let i = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const open = m[1] ?? m[3] ?? "";
    const inner = m[2] ?? "";
    const source = /<source\b([^>]*)>/i.exec(inner);
    const src = absolute(attr(open, "src") ?? (source ? attr(source[1]!, "src") : undefined), pageUrl);
    if (!src) continue;
    out.push({
      elementKey: `html-${i++}`,
      frameId: 0,
      src,
      poster: absolute(attr(open, "poster"), pageUrl),
      rectWidth: Number(attr(open, "width")) || 0,
      rectHeight: Number(attr(open, "height")) || 0,
      visibleRatio: 1,
      playing: false,
    });
  }
  return out;
}
