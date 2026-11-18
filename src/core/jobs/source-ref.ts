/**
 * Finding "the same video" again after a refresh, when every URL has changed.
 */
import type { SiteId, Variant, VariantKind, VideoSource } from "../model";
import { videoFamily } from "../codecs";

/** Per-track fingerprint taken when the job was planned. */
export interface TrackValidators {
  etag?: string;
  lastModified?: string;
  contentLength?: number;
  /** layoutHash() of the track's chunk list. */
  layout: string;
}

export interface SourceRef {
  pageUrl: string;
  site: SiteId;
  sourceId: string;
  title: string;
  duration?: number;
  variant: { kind: VariantKind; height?: number; bitrate?: number; codec?: string; id: string };
}

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|igshid|si|s|t|ref|ref_src|ref_url|share_id|context)$/i;

const HOST_ALIASES: Record<string, string> = {
  "twitter.com": "x.com",
  "mobile.twitter.com": "x.com",
  "mobile.x.com": "x.com",
  "old.reddit.com": "reddit.com",
  "new.reddit.com": "reddit.com",
  "www.reddit.com": "reddit.com",
  "sh.reddit.com": "reddit.com",
  "ptb.discord.com": "discord.com",
  "canary.discord.com": "discord.com",
};

/** Canonical page URL used to find a page's failed jobs after a refresh. */
export function canonicalPageUrl(raw: string): string {
  const u = new URL(raw);
  u.hash = "";
  const host = u.hostname.toLowerCase();
  u.hostname = HOST_ALIASES[host] ?? host.replace(/^www\./, "");
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = new URLSearchParams(kept).toString();
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  return u.toString();
}

export function makeSourceRef(source: VideoSource, variant: Variant | undefined): SourceRef {
  return {
    pageUrl: canonicalPageUrl(source.pageUrl),
    site: source.site,
    sourceId: source.id,
    title: source.title,
    duration: source.duration,
    variant: {
      kind: variant?.kind ?? "progressive",
      height: variant?.height,
      bitrate: variant?.bitrate,
      codec: variant?.videoCodec,
      id: variant?.id ?? "audio",
    },
  };
}

export type MatchResult =
  | { status: "found"; source: VideoSource; variant: Variant | undefined; via: "id" | "duration" }
  | { status: "not-found" }
  | { status: "ambiguous"; candidates: VideoSource[] };

const DURATION_TOLERANCE = 0.5;
const BITRATE_TOLERANCE = 0.1;

/** Same rendition in a freshly detected source. */
export function matchVariant(ref: SourceRef["variant"], variants: readonly Variant[]): Variant | undefined {
  const exact = variants.find((v) => v.id === ref.id);
  const family = videoFamily(ref.codec);
  const pool = variants.filter(
    (v) =>
      v.kind === ref.kind &&
      (ref.height === undefined || v.height === ref.height) &&
      (family === "unknown" || videoFamily(v.videoCodec) === "unknown" || videoFamily(v.videoCodec) === family),
  );
  if (ref.bitrate === undefined) return exact && pool.includes(exact) ? exact : pool[0];
  const near = pool
    .filter((v) => v.bitrate === undefined || Math.abs(v.bitrate - ref.bitrate!) <= ref.bitrate! * BITRATE_TOLERANCE)
    .sort((a, b) => Math.abs((a.bitrate ?? ref.bitrate!) - ref.bitrate!) - Math.abs((b.bitrate ?? ref.bitrate!) - ref.bitrate!));
  return near[0];
}

export function matchSource(ref: SourceRef, candidates: readonly VideoSource[], audioOnly = false): MatchResult {
  const pick = (source: VideoSource, via: "id" | "duration"): MatchResult => {
    if (audioOnly) return { status: "found", source, variant: undefined, via };
    const variant = matchVariant(ref.variant, source.variants);
    return variant ? { status: "found", source, variant, via } : { status: "not-found" };
  };

  const byId = candidates.find((s) => s.id === ref.sourceId);
  if (byId) return pick(byId, "id");

  // Fallback for DOM/network-only ids (hash of a URL that changed): same site,
  // same duration, and exactly one such video on the page.
  if (ref.duration === undefined) return { status: "not-found" };
  const sameLength = candidates.filter(
    (s) => s.site === ref.site && s.protection === "none" && s.duration !== undefined && Math.abs(s.duration - ref.duration!) <= DURATION_TOLERANCE,
  );
  if (sameLength.length === 1) return pick(sameLength[0]!, "duration");
  if (sameLength.length > 1) return { status: "ambiguous", candidates: sameLength };
  return { status: "not-found" };
}

/** Accept a video the user picked by hand (picker fallback). */
export function acceptsPicked(ref: SourceRef, picked: VideoSource): boolean {
  return ref.duration === undefined || picked.duration === undefined || Math.abs(picked.duration - ref.duration) <= DURATION_TOLERANCE;
}

/**
 * Did the bytes behind a track change? Strong validators decide when both
 * sides have them; otherwise size and chunk layout must agree.
 */
export function sameMedia(before: TrackValidators, now: TrackValidators): boolean {
  if (before.layout !== now.layout) return false;
  if (before.contentLength !== undefined && now.contentLength !== undefined && before.contentLength !== now.contentLength) return false;
  if (before.etag && now.etag) return stripWeak(before.etag) === stripWeak(now.etag);
  if (before.lastModified && now.lastModified) return before.lastModified === now.lastModified;
  return true;
}

function stripWeak(etag: string): string {
  return etag.replace(/^W\//, "");
}

/** If-Range needs a strong ETag or a Last-Modified date. */
export function ifRangeValue(v: TrackValidators | undefined): string | undefined {
  if (v?.etag && !v.etag.startsWith("W/")) return v.etag;
  return v?.lastModified;
}
