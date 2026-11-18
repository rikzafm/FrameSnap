/**
 * Discord adapter (spec §F6): message attachments on cdn.discordapp.com /
 * media.discordapp.net and Tenor / Giphy embeds (their mp4/webm renditions).
 * Attachment URLs are signed (`ex=`, `is=`, `hm=`) and rotate, so ids come from
 * the stable channel and attachment ids, never from the URL.
 */
import type { Container, Variant, VideoSource } from "../core/model";
import type { DetectContext, DomVideo, NetworkHit, SiteAdapter } from "./types";

const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;

function containerOf(path: string, contentType: string | undefined): Container {
  const ct = (contentType ?? "").toLowerCase();
  if (/\.webm$/i.test(path) || ct.includes("webm")) return "webm";
  return "mp4";
}

/** Discord's external proxy wraps the origin URL: /external/<sig>/https/<host>/<path>. */
function unwrapProxy(u: URL): URL {
  const m = /^\/external\/[^/]+\/(https?)\/([^/]+)(\/.*)?$/.exec(u.pathname);
  if (!m || !/(^|\.)discordapp\.(net|com)$/i.test(u.hostname)) return u;
  try {
    return new URL(`${m[1]}://${m[2]}${m[3] ?? "/"}${u.search}`);
  } catch {
    return u;
  }
}

interface Parsed {
  id: string;
  title?: string;
  path: string;
}

const slugTitle = (s: string): string | undefined => {
  const t = s.replace(/-/g, " ").trim();
  return t || undefined;
};

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function parseMediaUrl(raw: string): Parsed | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
  u = unwrapProxy(u);
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  if (!VIDEO_EXT.test(last)) return undefined;
  const stem = decode(last).replace(VIDEO_EXT, "");

  if (host === "cdn.discordapp.com" || host === "media.discordapp.net") {
    if (parts[0] !== "attachments" || parts.length < 4) return undefined;
    return { id: `discord:${parts[1]}/${parts[2]}`, title: stem || undefined, path: u.pathname };
  }
  if (host === "tenor.com" || host.endsWith(".tenor.com")) {
    if (parts.length < 2) return undefined;
    return { id: `discord:tenor/${parts[0]}`, title: slugTitle(stem), path: u.pathname };
  }
  if (host === "giphy.com" || host.endsWith(".giphy.com")) {
    const i = parts.indexOf("media");
    const gid = i >= 0 ? parts[i + 1] : undefined;
    if (!gid) return undefined;
    // "giphy.mp4" and friends carry no title; the generic page title is used instead.
    const generic = /^giphy(-\w+)?$/i.test(stem);
    return { id: `discord:giphy/${gid}`, title: generic ? undefined : slugTitle(stem), path: u.pathname };
  }
  return undefined;
}

function build(ctx: DetectContext, parsed: Parsed, url: string, by: "dom" | "network", extra: Partial<VideoSource>, variant: Partial<Variant>): VideoSource {
  return {
    id: parsed.id,
    site: "discord",
    title: parsed.title ?? ctx.pageTitle,
    pageUrl: ctx.pageUrl,
    variants: [
      {
        id: `progressive:${parsed.id}`,
        kind: "progressive",
        url,
        container: containerOf(parsed.path, undefined),
        hasAudio: true,
        ...variant,
      },
    ],
    audioTracks: [],
    protection: "none",
    detectedBy: [by],
    ...extra,
  };
}

function fromDom(ctx: DetectContext, v: DomVideo, parsed: Parsed): VideoSource {
  return build(
    ctx,
    parsed,
    v.src,
    "dom",
    {
      ...(v.poster ? { thumbnail: v.poster } : {}),
      ...(v.duration !== undefined && Number.isFinite(v.duration) ? { duration: v.duration } : {}),
      frameRef: { frameId: v.frameId, elementKey: v.elementKey },
      dom: { visibleRatio: v.visibleRatio, rectWidth: v.rectWidth, rectHeight: v.rectHeight, playing: v.playing },
    },
    v.videoHeight ? { width: v.videoWidth, height: v.videoHeight } : {},
  );
}

function fromNetwork(ctx: DetectContext, hit: NetworkHit, parsed: Parsed): VideoSource {
  return build(ctx, parsed, hit.url, "network", {}, {
    container: containerOf(parsed.path, hit.contentType),
    ...(hit.contentLength !== undefined ? { sizeBytes: hit.contentLength } : {}),
    ...(hit.acceptsRanges !== undefined ? { acceptsRanges: hit.acceptsRanges } : {}),
  });
}

export const discordAdapter: SiteAdapter = {
  site: "discord",
  matches(pageUrl) {
    try {
      const h = new URL(pageUrl).hostname.toLowerCase();
      return h === "discord.com" || h.endsWith(".discord.com");
    } catch {
      return false;
    }
  },
  detect(ctx) {
    const byId = new Map<string, VideoSource>();
    for (const v of ctx.domVideos) {
      const parsed = parseMediaUrl(v.src);
      if (parsed && !byId.has(parsed.id)) byId.set(parsed.id, fromDom(ctx, v, parsed));
    }
    for (const hit of ctx.network) {
      const parsed = parseMediaUrl(hit.url);
      if (parsed && !byId.has(parsed.id)) byId.set(parsed.id, fromNetwork(ctx, hit, parsed));
    }
    return [...byId.values()];
  },
};
