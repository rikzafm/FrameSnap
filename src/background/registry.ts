/**
 * Per-tab registry of detected videos. Finds are folded with mergeAll and
 * read back ordered by rankSources. The map is mirrored to
 * chrome.storage.session so a suspended service worker loses nothing.
 */
import { mergeAll, mergeSource, rankSources } from "../core/rank";
import type { VideoSource } from "../core/model";

export interface SessionArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface TabRegistry {
  /** Fold finds into the tab; returns the ranked list. */
  ingest(tabId: number, finds: readonly VideoSource[]): Promise<VideoSource[]>;
  /** Swap a source's variants/audio tracks for the expanded ones from `resolve`. */
  replaceResolved(tabId: number, resolved: VideoSource): Promise<VideoSource[]>;
  list(tabId: number): Promise<VideoSource[]>;
  clear(tabId: number): Promise<void>;
}

const key = (tabId: number) => `registry:${tabId}`;

export function createTabRegistry(session: SessionArea): TabRegistry {
  const cache = new Map<number, VideoSource[]>();
  let queue: Promise<unknown> = Promise.resolve();
  // one writer at a time: ingests from the sniffer, DOM scans and resolves interleave
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };

  async function load(tabId: number): Promise<VideoSource[]> {
    const hit = cache.get(tabId);
    if (hit) return hit;
    const stored = (await session.get(key(tabId)))[key(tabId)];
    const list = Array.isArray(stored) ? (stored as VideoSource[]) : [];
    cache.set(tabId, list);
    return list;
  }

  async function save(tabId: number, list: VideoSource[]): Promise<VideoSource[]> {
    cache.set(tabId, list);
    await session.set({ [key(tabId)]: list });
    return rankSources(list);
  }

  return {
    ingest: (tabId, finds) => serial(async () => save(tabId, mergeAll(await load(tabId), finds))),
    replaceResolved: (tabId, resolved) =>
      serial(async () => {
        const current = await load(tabId);
        const existing = current.find((s) => s.id === resolved.id);
        if (!existing) return save(tabId, mergeAll(current, [resolved]));
        const swapped = mergeSource({ ...existing, variants: [], audioTracks: [] }, resolved);
        return save(
          tabId,
          current.map((s) => (s.id === resolved.id ? swapped : s)),
        );
      }),
    list: async (tabId) => rankSources(await load(tabId)),
    clear: (tabId) =>
      serial(async () => {
        cache.delete(tabId);
        await session.remove(key(tabId));
      }),
  };
}
