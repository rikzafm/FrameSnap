/**
 * File-name templates: {title} {site} {date} {resolution} {time}
 * Output is safe for chrome.downloads on Windows, macOS and Linux.
 */

export interface FilenameFields {
  title: string;
  site: string;
  /** When the download was started. */
  date: Date;
  height?: number;
  width?: number;
  /** Playback position in seconds (frame snaps). */
  time?: number;
}

export const DEFAULT_TEMPLATE = "{title}-{site}-{resolution}";
const MAX_BASENAME = 150;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export function formatTimecode(seconds: number, sep = "-"): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  const base = h > 0 ? `${h}${sep}${mm}${sep}${ss}` : `${mm}${sep}${ss}`;
  return ms > 0 ? `${base}.${String(ms).padStart(3, "0")}` : base;
}

function resolutionLabel(f: FilenameFields): string {
  if (f.height) return `${f.height}p`;
  if (f.width) return `${f.width}w`;
  return "";
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Make one path segment safe. Never returns an empty string. */
export function sanitizeSegment(input: string, fallback = "video"): string {
  let s = input
    .normalize("NFC")
    // control chars and characters illegal on Windows
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, " ")
    // emoji and pictographs: legal, but break some file managers and sync tools
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    // no leading dots (hidden files) and no trailing dots/spaces (Windows)
    .replace(/^[.\s]+/, "")
    .replace(/[.\s]+$/, "");
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  if (s.length > MAX_BASENAME) s = s.slice(0, MAX_BASENAME).replace(/[.\s-]+$/, "");
  return s || fallback;
}

/** Render a template to a base name (no extension). Unknown tokens stay literal. */
export function renderTemplate(template: string, f: FilenameFields): string {
  const values: Record<string, string> = {
    title: f.title,
    site: f.site,
    date: isoDate(f.date),
    resolution: resolutionLabel(f),
    time: f.time === undefined ? "" : formatTimecode(f.time),
  };
  const out = template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? values[key]! : whole));
  // collapse separators left behind by empty tokens: "a--b", "a- -b", leading/trailing "-"
  const tidy = out.replace(/([-_ ])(?:[-_ ]*\1)+/g, "$1").replace(/^[-_ ]+|[-_ ]+$/g, "");
  return sanitizeSegment(tidy, sanitizeSegment(f.title));
}

export function buildFilename(template: string, f: FilenameFields, extension: string): string {
  const ext = extension.replace(/^\./, "").toLowerCase();
  return `${renderTemplate(template, f)}.${ext}`;
}
