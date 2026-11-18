/**
 * Chunk-store housekeeping (spec §4.5 step 8). Pure: decides which jobs'
 * chunks to delete; the caller deletes them and their job records.
 */
import type { JobRecord } from "./job";
import type { StoredJob } from "./store";

/** The part of a record the policy reads (so the sweep can ship it across the engine port). */
export type SweepRecord = Pick<JobRecord, "id" | "status" | "resumable" | "updatedAt">;

export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_STORE_BYTES = 4 * 1024 * 1024 * 1024;

/** Store cap: half the origin quota, never more than 4 GB. */
export function storeCap(quotaBytes: number | undefined): number {
  return Math.min(MAX_STORE_BYTES, Math.floor((quotaBytes ?? MAX_STORE_BYTES * 2) / 2));
}

export function selectEvictions(stored: readonly StoredJob[], records: readonly SweepRecord[], now: number, capBytes: number): string[] {
  const byId = new Map(records.map((r) => [r.id, r]));
  const evict = new Set<string>();

  for (const s of stored) {
    const r = byId.get(s.jobId);
    if (!r) evict.add(s.jobId); // orphan: record gone
    else if (r.status === "done" || r.status === "cancelled") evict.add(s.jobId);
    else if (r.status === "failed" && (!r.resumable || now - r.updatedAt > MAX_AGE_MS)) evict.add(s.jobId);
  }

  let total = stored.filter((s) => !evict.has(s.jobId)).reduce((sum, s) => sum + s.bytes, 0);
  if (total > capBytes) {
    // oldest failed jobs first; running/queued jobs are never evicted
    const candidates = stored
      .filter((s) => !evict.has(s.jobId) && byId.get(s.jobId)?.status === "failed")
      .sort((a, b) => (byId.get(a.jobId)!.updatedAt || a.updatedAt) - (byId.get(b.jobId)!.updatedAt || b.updatedAt));
    for (const s of candidates) {
      if (total <= capBytes) break;
      evict.add(s.jobId);
      total -= s.bytes;
    }
  }
  return [...evict];
}
