/**
 * DASH MPD parser. Expands every Representation into a flat segment list:
 * SegmentTemplate ($Number$ / $Time$ / SegmentTimeline), SegmentList and
 * SegmentBase / plain BaseURL (one file, chunked by byte range later).
 * Only the first Period is used; multi-period MPDs (ad insertion) are flagged.
 */
import { child, children, parseXml, type XmlNode } from "./xml";
import type { ByteRange } from "./hls";

export interface DashSegment {
  /** Stable resume key: "init", "n<Number>", "t<Time>", "i<index>" or "whole". */
  key: string;
  url: string;
  byteRange?: ByteRange;
  /** Seconds from period start. */
  start: number;
  duration: number;
}

export interface DashRepresentation {
  id: string;
  contentType: "video" | "audio" | "other";
  mimeType: string;
  codecs?: string;
  bandwidth: number;
  width?: number;
  height?: number;
  frameRate?: number;
  language?: string;
  init?: DashSegment;
  segments: DashSegment[];
  /** "whole": one file (SegmentBase / BaseURL only). */
  addressing: "template" | "list" | "whole";
}

export interface DashManifest {
  live: boolean;
  duration?: number;
  multiPeriod: boolean;
  protection: "none" | "drm";
  video: DashRepresentation[];
  audio: DashRepresentation[];
}

/** ISO-8601 duration (PnDTnHnMnS) → seconds. */
export function parseIsoDuration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s.trim());
  if (!m) return undefined;
  const [, d, h, min, sec] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(sec ?? 0);
}

function parseRange(r: string | undefined): ByteRange | undefined {
  if (!r) return undefined;
  const [a, b] = r.split("-").map(Number);
  if (a === undefined || b === undefined || !Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return { offset: a, length: b - a + 1 };
}

/** Fill $RepresentationID$, $Bandwidth$, $Number%05d$, $Time$, $$. */
export function fillTemplate(tpl: string, vars: { RepresentationID: string; Bandwidth: number; Number?: number; Time?: number }): string {
  return tpl.replace(/\$(\w*)(?:%0(\d+)d)?\$/g, (whole, name: string, width: string | undefined) => {
    if (name === "") return "$";
    const v = (vars as Record<string, string | number | undefined>)[name];
    if (v === undefined) return whole;
    const s = String(v);
    return width ? s.padStart(Number(width), "0") : s;
  });
}

function joinBase(base: string, node: XmlNode | undefined): string {
  const b = child(node, "BaseURL")?.text.trim();
  return b ? new URL(b, base).toString() : base;
}

/** Inherited attributes: Representation overrides AdaptationSet overrides Period. */
function mergedTemplate(...nodes: (XmlNode | undefined)[]): XmlNode | undefined {
  let out: XmlNode | undefined;
  for (const n of nodes) {
    const t = child(n, "SegmentTemplate");
    if (!t) continue;
    out = out
      ? { ...t, attrs: { ...out.attrs, ...t.attrs }, children: t.children.length ? t.children : out.children }
      : t;
  }
  return out;
}

function classify(mime: string, contentType: string | undefined, codecs: string | undefined): DashRepresentation["contentType"] {
  const t = contentType ?? mime.split("/")[0];
  if (t === "video") return "video";
  if (t === "audio") return "audio";
  if (codecs && /^(avc|hvc|hev|vp0?[89]|av01)/.test(codecs)) return "video";
  if (codecs && /^(mp4a|opus|vorbis|ac-3|ec-3)/.test(codecs)) return "audio";
  return "other";
}

function expandTemplate(
  tpl: XmlNode,
  base: string,
  rep: { id: string; bandwidth: number },
  periodDuration: number | undefined,
): { init?: DashSegment; segments: DashSegment[] } {
  const a = tpl.attrs;
  const timescale = Number(a.timescale ?? 1);
  const startNumber = Number(a.startNumber ?? 1);
  const pto = Number(a.presentationTimeOffset ?? 0);
  const vars = { RepresentationID: rep.id, Bandwidth: rep.bandwidth };
  const init = a.initialization
    ? { key: "init", url: new URL(fillTemplate(a.initialization, vars), base).toString(), start: 0, duration: 0 }
    : undefined;
  const media = a.media;
  if (!media) return { init, segments: [] };

  const segments: DashSegment[] = [];
  const timeline = child(tpl, "SegmentTimeline");
  if (timeline) {
    let t = 0;
    let number = startNumber;
    for (const s of children(timeline, "S")) {
      const d = Number(s.attrs.d);
      if (s.attrs.t !== undefined) t = Number(s.attrs.t);
      let r = Number(s.attrs.r ?? 0);
      if (r < 0) {
        // repeat until the period ends
        r = periodDuration !== undefined ? Math.ceil((periodDuration * timescale - (t - pto)) / d) - 1 : 0;
      }
      for (let k = 0; k <= r; k++) {
        const byTime = media.includes("$Time$");
        segments.push({
          key: byTime ? `t${t}` : `n${number}`,
          url: new URL(fillTemplate(media, { ...vars, Number: number, Time: t }), base).toString(),
          start: (t - pto) / timescale,
          duration: d / timescale,
        });
        t += d;
        number++;
      }
    }
  } else {
    const d = Number(a.duration ?? 0);
    if (!d || periodDuration === undefined) return { init, segments };
    const segDur = d / timescale;
    const count = Math.ceil(periodDuration / segDur - 1e-9);
    for (let k = 0; k < count; k++) {
      const number = startNumber + k;
      segments.push({
        key: `n${number}`,
        url: new URL(fillTemplate(media, { ...vars, Number: number, Time: k * d }), base).toString(),
        start: k * segDur,
        duration: Math.min(segDur, periodDuration - k * segDur),
      });
    }
  }
  return { init, segments };
}

function expandList(list: XmlNode, base: string, periodDuration: number | undefined): { init?: DashSegment; segments: DashSegment[] } {
  const timescale = Number(list.attrs.timescale ?? 1);
  const d = Number(list.attrs.duration ?? 0) / timescale;
  const initNode = child(list, "Initialization");
  const init = initNode
    ? {
        key: "init",
        url: initNode.attrs.sourceURL ? new URL(initNode.attrs.sourceURL, base).toString() : base,
        byteRange: parseRange(initNode.attrs.range),
        start: 0,
        duration: 0,
      }
    : undefined;
  const urls = children(list, "SegmentURL");
  const segments = urls.map((u, i) => ({
    key: `i${i}`,
    url: u.attrs.media ? new URL(u.attrs.media, base).toString() : base,
    byteRange: parseRange(u.attrs.mediaRange),
    start: i * d,
    duration: d || (periodDuration ?? 0) / urls.length,
  }));
  return { init, segments };
}

export function parseMpd(text: string, mpdUrl: string): DashManifest {
  const mpd = parseXml(text);
  if (mpd.name !== "MPD") throw new Error("DASH: root is not <MPD>");
  const periods = children(mpd, "Period");
  const period = periods[0];
  const live = mpd.attrs.type === "dynamic";
  const duration = parseIsoDuration(period?.attrs.duration) ?? parseIsoDuration(mpd.attrs.mediaPresentationDuration);
  const out: DashManifest = { live, duration, multiPeriod: periods.length > 1, protection: "none", video: [], audio: [] };
  if (!period) return out;

  const mpdBase = joinBase(mpdUrl, mpd);
  const periodBase = joinBase(mpdBase, period);

  for (const set of children(period, "AdaptationSet")) {
    const setBase = joinBase(periodBase, set);
    if (children(set, "ContentProtection").length) out.protection = "drm";
    for (const rep of children(set, "Representation")) {
      if (children(rep, "ContentProtection").length) out.protection = "drm";
      const mimeType = rep.attrs.mimeType ?? set.attrs.mimeType ?? "";
      const codecs = rep.attrs.codecs ?? set.attrs.codecs;
      const contentType = classify(mimeType, set.attrs.contentType, codecs);
      if (contentType === "other") continue;
      const id = rep.attrs.id ?? `${out.video.length + out.audio.length}`;
      const bandwidth = Number(rep.attrs.bandwidth ?? 0);
      const base = joinBase(setBase, rep);
      const fr = rep.attrs.frameRate ?? set.attrs.frameRate;

      const r: DashRepresentation = {
        id,
        contentType,
        mimeType,
        codecs,
        bandwidth,
        width: rep.attrs.width ? Number(rep.attrs.width) : undefined,
        height: rep.attrs.height ? Number(rep.attrs.height) : undefined,
        frameRate: fr ? fr.split("/").map(Number).reduce((x, y) => x / y) : undefined,
        language: set.attrs.lang,
        segments: [],
        addressing: "whole",
      };

      const tpl = mergedTemplate(period, set, rep);
      const list = child(rep, "SegmentList") ?? child(set, "SegmentList");
      if (tpl) {
        Object.assign(r, expandTemplate(tpl, base, { id, bandwidth }, duration), { addressing: "template" });
      } else if (list) {
        Object.assign(r, expandList(list, base, duration), { addressing: "list" });
      } else {
        // SegmentBase or bare BaseURL: one progressive file
        r.segments = [{ key: "whole", url: base, start: 0, duration: duration ?? 0 }];
      }
      (contentType === "video" ? out.video : out.audio).push(r);
    }
  }
  out.video.sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth);
  out.audio.sort((a, b) => b.bandwidth - a.bandwidth);
  return out;
}
