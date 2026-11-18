/**
 * User settings: pure defaults and migration. Persisted by
 * platform/settings-store.ts under a single storage key.
 */
import { DEFAULT_TEMPLATE } from "./filename";
import type { OutputFormat } from "./model";

export const SETTINGS_VERSION = 1;

export type Theme = "light" | "dark" | "system";

export interface Settings {
  version: number;
  theme: Theme;
  defaultFormat: OutputFormat;
  filenameTemplate: string;
}

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  theme: "system",
  defaultFormat: "mp4",
  filenameTemplate: DEFAULT_TEMPLATE,
};

const THEMES: readonly string[] = ["light", "dark", "system"];
const FORMATS: readonly string[] = ["mp4", "webm", "mkv", "mov", "mp3", "m4a"];

/** Any stored value (missing, old, or corrupt) → a valid current Settings. */
export function migrateSettings(raw: unknown): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (typeof r.theme === "string" && THEMES.includes(r.theme)) out.theme = r.theme as Theme;
  if (typeof r.defaultFormat === "string" && FORMATS.includes(r.defaultFormat)) out.defaultFormat = r.defaultFormat as OutputFormat;
  if (typeof r.filenameTemplate === "string" && r.filenameTemplate.trim() !== "") out.filenameTemplate = r.filenameTemplate;
  return out;
}
