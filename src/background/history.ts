/**
 * Finished downloads, newest first, kept in chrome.storage.local under
 * `history`. The options page (history list) reads the same key.
 */
import type { HistoryEntry } from "./download";

export const HISTORY_KEY = "history";
export const HISTORY_LIMIT = 200;

export interface HistoryArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function createHistoryStore(area: HistoryArea) {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    async list(): Promise<HistoryEntry[]> {
      const v = (await area.get(HISTORY_KEY))[HISTORY_KEY];
      return Array.isArray(v) ? (v as HistoryEntry[]) : [];
    },
    add(entry: HistoryEntry): Promise<void> {
      const run = chain.then(async () => {
        const v = (await area.get(HISTORY_KEY))[HISTORY_KEY];
        const list = Array.isArray(v) ? (v as HistoryEntry[]) : [];
        await area.set({ [HISTORY_KEY]: [entry, ...list.filter((e) => e.id !== entry.id)].slice(0, HISTORY_LIMIT) });
      });
      chain = run.catch(() => undefined);
      return run;
    },
  };
}
