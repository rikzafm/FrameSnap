/** Per-site memory of the popup's last mode (Video / GIF / Screenshot). */
export type Mode = "video" | "gif" | "screenshot";

export const MODE_KEY = "popup/modeBySite";
const MODES: readonly string[] = ["video", "gif", "screenshot"];

export interface ModeArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function siteKey(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export function createModeMemory(area: ModeArea) {
  const load = async (): Promise<Record<string, string>> => {
    const raw = (await area.get(MODE_KEY))[MODE_KEY];
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, string>) : {};
  };
  return {
    /** Remembered mode per host. */
    async all(): Promise<Record<string, Mode>> {
      return Object.fromEntries(Object.entries(await load()).filter(([, m]) => MODES.includes(m))) as Record<string, Mode>;
    },
    async remove(host: string): Promise<void> {
      const { [host]: _gone, ...rest } = await load();
      void _gone;
      await area.set({ [MODE_KEY]: rest });
    },
    async get(url: string): Promise<Mode> {
      const k = siteKey(url);
      const m = k ? (await load())[k] : undefined;
      return m && MODES.includes(m) ? (m as Mode) : "video";
    },
    async set(url: string, mode: Mode): Promise<void> {
      const k = siteKey(url);
      if (!k) return;
      await area.set({ [MODE_KEY]: { ...(await load()), [k]: mode } });
    },
  };
}
