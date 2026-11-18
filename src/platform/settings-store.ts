/** get/set/subscribe for user settings over chrome.storage.local. */
import { migrateSettings, type Settings } from "../core/settings";

export const SETTINGS_KEY = "settings";

export interface SettingsArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

type ChangeListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;

export interface ChangeEvents {
  addListener(fn: ChangeListener): void;
  removeListener(fn: ChangeListener): void;
}

export interface SettingsStore {
  get(): Promise<Settings>;
  set(patch: Partial<Settings>): Promise<Settings>;
  subscribe(fn: (s: Settings) => void): () => void;
}

export function createSettingsStore(area: SettingsArea, events: ChangeEvents): SettingsStore {
  const get = async () => migrateSettings((await area.get(SETTINGS_KEY))[SETTINGS_KEY]);
  return {
    get,
    async set(patch) {
      const next = migrateSettings({ ...(await get()), ...patch });
      await area.set({ [SETTINGS_KEY]: next });
      return next;
    },
    subscribe(fn) {
      const listener: ChangeListener = (changes, areaName) => {
        const c = changes[SETTINGS_KEY];
        if (areaName === "local" && c) fn(migrateSettings(c.newValue));
      };
      events.addListener(listener);
      return () => events.removeListener(listener);
    },
  };
}

/** Store bound to the real extension APIs. */
export const settingsStore = (): SettingsStore => createSettingsStore(chrome.storage.local, chrome.storage.onChanged);
