/**
 * Options-page data: the history list, interrupted (resumable) jobs and
 * "Clear all" with undo. Storage and the chunk store come in as dependencies.
 */
import type { HistoryEntry } from "../background/download";
import { HISTORY_KEY } from "../background/history";
import { JOB_PREFIX, jobKey } from "../background/job-store";
import type { JobRecord } from "../core/jobs/job";
import type { ChunkStore } from "../core/jobs/store";

export const HISTORY_SHOWN = 20;
/** How long "Clear all" can be undone before the partial data is deleted for good. */
export const UNDO_MS = 8000;

export interface OptionsArea {
  get(keys: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface StoppedRow {
  id: string;
  title: string;
  /** 0-100, how far the download got. */
  percent: number;
  /** Partial data kept on this device. */
  bytes: number;
  pageUrl: string;
}

export interface OptionsDataDeps {
  area: OptionsArea;
  chunks: ChunkStore;
  schedule?(fn: () => void, ms: number): unknown;
  cancelSchedule?(handle: unknown): void;
  undoMs?: number;
}

interface Snapshot {
  history: HistoryEntry[];
  records: Record<string, unknown>;
  chunkJobs: string[];
}

export function createOptionsData(deps: OptionsDataDeps) {
  const { area, chunks } = deps;
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancelSchedule = deps.cancelSchedule ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let pending: { snap: Snapshot; handle: unknown } | undefined;
  let deleting: Promise<unknown> = Promise.resolve();

  const readHistory = async (): Promise<HistoryEntry[]> => {
    const v = (await area.get(HISTORY_KEY))[HISTORY_KEY];
    return Array.isArray(v) ? (v as HistoryEntry[]) : [];
  };
  const readJobs = async (): Promise<JobRecord[]> =>
    Object.entries(await area.get(null))
      .filter(([k]) => k.startsWith(JOB_PREFIX))
      .map(([, v]) => v as JobRecord);

  /** Delete the chunks of a cleared snapshot for good. */
  const commit = () => {
    if (!pending) return;
    const { snap, handle } = pending;
    pending = undefined;
    cancelSchedule(handle);
    deleting = deleting.then(() => Promise.all(snap.chunkJobs.map((id) => chunks.deleteJob(id).catch(() => undefined))));
  };

  return {
    async history(): Promise<HistoryEntry[]> {
      return (await readHistory()).slice(0, HISTORY_SHOWN);
    },

    async stopped(): Promise<StoppedRow[]> {
      const sizes = new Map((await chunks.jobs().catch(() => [])).map((j) => [j.jobId, j.bytes]));
      return (await readJobs())
        .filter((j) => j.status === "failed" && j.resumable)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((j) => ({
          id: j.id,
          title: j.source.title,
          percent: Math.round(Math.min(1, Math.max(0, j.progress)) * 100),
          bytes: sizes.get(j.id) ?? 0,
          pageUrl: j.source.pageUrl,
        }));
    },

    async discard(jobId: string): Promise<void> {
      await area.remove([jobKey(jobId)]);
      await chunks.deleteJob(jobId);
    },

    /** Empty history and every finished job record now; delete the partial data once the undo window ends. */
    async clearAll(): Promise<void> {
      commit();
      const history = await readHistory();
      const all = Object.entries(await area.get(null)).filter(([k]) => k.startsWith(JOB_PREFIX));
      const live = new Set(all.filter(([, v]) => ["running", "queued"].includes((v as JobRecord).status)).map(([k]) => k.slice(JOB_PREFIX.length)));
      const records = Object.fromEntries(all.filter(([k]) => !live.has(k.slice(JOB_PREFIX.length))));
      const chunkJobs = (await chunks.jobs().catch(() => [])).map((j) => j.jobId).filter((id) => !live.has(id));
      for (const id of Object.keys(records).map((k) => k.slice(JOB_PREFIX.length))) if (!chunkJobs.includes(id)) chunkJobs.push(id);
      const snap = { history, records, chunkJobs };
      await area.set({ [HISTORY_KEY]: [] });
      await area.remove(Object.keys(records));
      pending = { snap, handle: schedule(commit, deps.undoMs ?? UNDO_MS) };
    },

    canUndo: () => pending !== undefined,

    async undo(): Promise<void> {
      if (!pending) return;
      const { snap, handle } = pending;
      pending = undefined;
      cancelSchedule(handle);
      await area.set({ [HISTORY_KEY]: snap.history, ...snap.records });
    },

    /** Delete any pending partial data now (the page is closing). */
    flush: commit,

    /** Resolves once queued chunk deletions have finished. */
    settled: () => deleting,
  };
}
