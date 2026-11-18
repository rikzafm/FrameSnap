/**
 * User settings: pure defaults and migration. Persisted by
 * platform/settings-store.ts under a single storage key.
 */
import { DEFAULT_TEMPLATE } from "./filename";
import type { AudioMode, GifOptions, OutputFormat, VideoSource } from "./model";

export const SETTINGS_VERSION = 1;

export type Theme = "light" | "dark" | "system";

export interface Settings {
  version: number;
  theme: Theme;
  defaultFormat: OutputFormat;
  filenameTemplate: string;
  /** Variant id, or "best". */
  defaultQuality: string;
  defaultAudio: AudioMode;
  /** GIF defaults (trim is per clip, so it is not stored). */
  gif: Pick<GifOptions, "fps" | "width" | "loop" | "dither">;
  /** The first-run notice has been acknowledged (the popup banner stops showing). */
  acknowledged: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  theme: "system",
  defaultFormat: "mp4",
  filenameTemplate: DEFAULT_TEMPLATE,
  defaultQuality: "best",
  defaultAudio: "keep",
  gif: { fps: 15, width: 480, loop: 0, dither: true },
  acknowledged: false,
};

const THEMES: readonly string[] = ["light", "dark", "system"];
const AUDIO: readonly unknown[] = ["keep", "remove", "only"];
const FPS: readonly unknown[] = [10, 15, 24, 30];
const WIDTHS: readonly unknown[] = [320, 480, 640, "original"];
const FORMATS: readonly string[] = ["mp4", "webm", "mkv", "mov", "mp3", "m4a"];

/** Any stored value (missing, old, or corrupt) → a valid current Settings. */
export function migrateSettings(raw: unknown): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS, gif: { ...DEFAULT_SETTINGS.gif } };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.theme === "string" && THEMES.includes(r.theme)) out.theme = r.theme as Theme;
  if (typeof r.defaultFormat === "string" && FORMATS.includes(r.defaultFormat)) out.defaultFormat = r.defaultFormat as OutputFormat;
  if (typeof r.filenameTemplate === "string" && r.filenameTemplate.trim() !== "") out.filenameTemplate = r.filenameTemplate;
  if (typeof r.defaultQuality === "string" && r.defaultQuality !== "") out.defaultQuality = r.defaultQuality;
  if (AUDIO.includes(r.defaultAudio)) out.defaultAudio = r.defaultAudio as AudioMode;
  if (typeof r.acknowledged === "boolean") out.acknowledged = r.acknowledged;
  if (typeof r.gif === "object" && r.gif !== null && !Array.isArray(r.gif)) {
    const g = r.gif as Record<string, unknown>;
    const gif = { ...DEFAULT_SETTINGS.gif };
    if (FPS.includes(g.fps)) gif.fps = g.fps as GifOptions["fps"];
    if (WIDTHS.includes(g.width)) gif.width = g.width as GifOptions["width"];
    if (typeof g.loop === "number" && Number.isInteger(g.loop) && g.loop >= 0) gif.loop = g.loop;
    if (typeof g.dither === "boolean") gif.dither = g.dither;
    out.gif = gif;
  } else out.gif = { ...DEFAULT_SETTINGS.gif };
  return out;
}

/**
 * The default quality is "best" or a height cap like "h720" (variant ids are
 * per video). Resolves it against one source to a variant id, or "best".
 */
export function resolveDefaultQuality(source: Pick<VideoSource, "variants">, pref: string): string {
  const m = /^h(\d+)$/.exec(pref);
  if (!m) return "best";
  const cap = Number(m[1]);
  const fit = source.variants.filter((v) => v.height !== undefined && v.height <= cap).sort((a, b) => (b.height ?? 0) - (a.height ?? 0))[0];
  return fit ? fit.id : "best";
}
