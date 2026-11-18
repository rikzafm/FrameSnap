/**
 * Job-record persistence over a chrome.storage-like area, keyed `jobs/<id>`.
 * Chunk commits arrive in bursts, so they are batched into at most one
 * storage write per `intervalMs`.
 */
import { commitChunks as applyCommits, type JobRecord } from "../core/jobs/job";

export interface StorageAreaLike {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface ChunkCommit {
  trackId: string;
  key: string;
}

export interface JobStore {
  get(id: string): Promise<JobRecord | undefined>;
  list(): Promise<JobRecord[]>;
  /** Write now. Includes any pending commits for the same job. */
  put(job: JobRecord): Promise<void>;
  remove(id: string): Promise<void>;
  /** Queue commits; persisted by the next batched flush. */
  commitChunks(jobId: string, commits: readonly ChunkCommit[]): void;
  /** Write everything pending now. */
  flush(): Promise<void>;
}

export const JOB_PREFIX = "jobs/";
export const jobKey = (id: string) => JOB_PREFIX + id;

export interface JobStoreDeps {
  area: StorageAreaLike;
  now?: () => number;
  /** Minimum gap between batched writes. */
  intervalMs?: number;
}

export function createJobStore({ area, now = Date.now, intervalMs = 1000 }: JobStoreDeps): JobStore {
  const pending = new Map<string, ChunkCommit[]>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();

  const read = async (id: string) => (await area.get(jobKey(id)))[jobKey(id)] as JobRecord | undefined;
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  async function writePending(): Promise<void> {
    if (pending.size === 0) return;
    const batch = [...pending];
    pending.clear();
    const items: Record<string, unknown> = {};
    for (const [id, commits] of batch) {
      const rec = await read(id);
      if (rec) items[jobKey(id)] = applyCommits(rec, commits, now());
    }
    if (Object.keys(items).length > 0) await area.set(items);
  }

  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    return serial(writePending);
  };

  return {
    async get(id) {
      await flush();
      return read(id);
    },
    async list() {
      await flush();
      const all = await area.get(null);
      return Object.entries(all)
        .filter(([k]) => k.startsWith(JOB_PREFIX))
        .map(([, v]) => v as JobRecord);
    },
    async put(job) {
      await flush();
      await serial(() => area.set({ [jobKey(job.id)]: job }));
    },
    async remove(id) {
      pending.delete(id);
      await serial(() => area.remove(jobKey(id)));
    },
    commitChunks(jobId, commits) {
      if (commits.length === 0) return;
      pending.set(jobId, [...(pending.get(jobId) ?? []), ...commits]);
      timer ??= setTimeout(() => {
        timer = undefined;
        void serial(writePending);
      }, intervalMs);
    },
    flush,
  };
}
