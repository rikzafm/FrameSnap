/**
 * Detection merge and ranking (spec §4.2).
 * DOM, network and adapter results describe the same video from different
 * angles; the registry folds them into one VideoSource per id.
 */
import { isKnownDrmHost } from "./drm";
import type { Variant, VideoSource } from "./model";

/** Highest = most likely the video the user means. */
export function score(src: VideoSource): number {
  if (src.protection === "drm") return -1;
  const best = bestVariant(src.variants);
  const heightTerm = Math.log2(1 + (best?.height ?? 0));
  if (!src.dom) return heightTerm; // network/adapter-only finds rank below anything visible
  const area = src.dom.rectWidth * src.dom.rectHeight * src.dom.visibleRatio;
  return area * (src.dom.playing ? 2 : 1) + heightTerm;
}

export function rankSources(sources: readonly VideoSource[]): VideoSource[] {
  return [...sources].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
}

/** Variant the "Best available" quality resolves to. */
export function bestVariant(variants: readonly Variant[]): Variant | undefined {
  let best: Variant | undefined;
  for (const v of variants) {
    if (!best) {
      best = v;
      continue;
    }
    const dh = (v.height ?? 0) - (best.height ?? 0);
    if (dh > 0 || (dh === 0 && (v.bitrate ?? 0) > (best.bitrate ?? 0))) best = v;
  }
  return best;
}

function mergeVariants(a: readonly Variant[], b: readonly Variant[]): Variant[] {
  const byKey = new Map<string, Variant>();
  for (const v of [...a, ...b]) {
    // DASH renditions all share the MPD url, so the rendition id is part of the key
    const key = v.kind === "dash" ? `${v.url.split("#")[0]!}#${v.id}` : v.url.split("#")[0]!;
    const prev = byKey.get(key);
    byKey.set(key, prev ? { ...prev, ...definedOnly(v) } : v);
  }
  return [...byKey.values()].sort((x, y) => (y.height ?? 0) - (x.height ?? 0) || (y.bitrate ?? 0) - (x.bitrate ?? 0));
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Merge two descriptions of the same video. `b` wins on scalar fields it defines. */
export function mergeSource(a: VideoSource, b: VideoSource): VideoSource {
  return {
    ...a,
    ...definedOnly(b),
    title: b.title || a.title,
    variants: mergeVariants(a.variants, b.variants),
    audioTracks: [...new Map([...a.audioTracks, ...b.audioTracks].map((t) => [t.url, t])).values()],
    protection: a.protection === "drm" || b.protection === "drm" ? "drm" : "none",
    detectedBy: [...new Set([...a.detectedBy, ...b.detectedBy])],
    frameRef: b.frameRef ?? a.frameRef,
    dom: b.dom ?? a.dom,
    headers: a.headers || b.headers ? { ...a.headers, ...b.headers } : undefined,
  };
}

/**
 * Fold a batch of finds into the registry. A find whose variant URL is already
 * known under another id is merged into that id, so a sniffed .m3u8 and the
 * adapter's entry for the same post end up as one card.
 */
export function mergeAll(existing: readonly VideoSource[], incoming: readonly VideoSource[]): VideoSource[] {
  const byId = new Map(existing.map((s) => [s.id, s]));
  const idByUrl = new Map<string, string>();
  for (const s of byId.values()) for (const v of s.variants) idByUrl.set(v.url, s.id);

  for (const s of incoming) {
    const aliasId = byId.has(s.id) ? s.id : s.variants.map((v) => idByUrl.get(v.url)).find((id) => id !== undefined);
    const target = aliasId ? byId.get(aliasId) : undefined;
    // adapter ids are canonical: keep the adapter's id when the two meet
    const merged = target ? mergeSource(target, s) : s;
    const id = target && s.detectedBy.includes("adapter") ? s.id : (target?.id ?? s.id);
    if (target && id !== target.id) byId.delete(target.id);
    byId.set(id, { ...merged, id });
    for (const v of merged.variants) idByUrl.set(v.url, id);
  }
  return [...byId.values()].map((s) => (s.protection !== "drm" && isKnownDrmHost(s.pageUrl) ? { ...s, protection: "drm" as const } : s));
}
