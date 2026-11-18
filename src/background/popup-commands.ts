/**
 * Job commands from the popup (download, GIF, save, resume, discard, cancel).
 * A command that throws would otherwise vanish, so every one reports a failed
 * job event the popup can show.
 */
import { toAppError } from "../core/errors";
import type { JobEvent, PopupToWorker } from "../core/messages";
import type { DownloadOrchestrator } from "./download";

export interface JobCommandDeps {
  orchestrator: Pick<DownloadOrchestrator, "download" | "startGif" | "saveGif" | "resume" | "discard" | "cancel">;
  settings(): Promise<{ filenameTemplate: string }>;
  emit(event: JobEvent): void;
  newId?(): string;
}

export interface JobCommands {
  /** Runs the command when `msg` is one; returns whether it was. */
  handle(msg: PopupToWorker): boolean;
  /** Resolves once every command started so far has finished (for tests). */
  idle(): Promise<void>;
}

type JobMessage = Extract<PopupToWorker, { t: `job/${string}` }>;

export function createJobCommands(deps: JobCommandDeps): JobCommands {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const pending = new Set<Promise<void>>();

  /** Runs `work`; on a throw, emits a failed event under `jobId`, or under a fresh id when no job exists yet. */
  const guarded = (jobId: string | undefined, work: () => Promise<unknown>): void => {
    const p = work().then(
      () => undefined,
      (err: unknown) => deps.emit({ t: "failed", jobId: jobId ?? newId(), error: toAppError(err), resumable: false, keptRatio: 0 }),
    );
    pending.add(p);
    void p.finally(() => pending.delete(p));
  };

  const table: { [K in JobMessage["t"]]: (m: Extract<JobMessage, { t: K }>) => void } = {
    "job/download": (m) => guarded(undefined, () => deps.orchestrator.download({ tabId: m.tabId, sourceId: m.sourceId, options: m.options })),
    "job/gif": (m) =>
      guarded(undefined, async () => {
        const { filenameTemplate } = await deps.settings();
        await deps.orchestrator.startGif({ tabId: m.tabId, sourceId: m.sourceId, options: m.options, filenameTemplate });
      }),
    "job/save": (m) => guarded(m.jobId, () => deps.orchestrator.saveGif(m.jobId)),
    "job/resume": (m) => guarded(m.jobId, () => deps.orchestrator.resume(m.jobId, m.tabId)),
    "job/discard": (m) => guarded(m.jobId, () => deps.orchestrator.discard(m.jobId)),
    "job/cancel": (m) => guarded(m.jobId, () => deps.orchestrator.cancel(m.jobId)),
  };

  return {
    handle(msg) {
      if (!Object.hasOwn(table, msg.t)) return false;
      (table[msg.t as JobMessage["t"]] as (m: PopupToWorker) => void)(msg);
      return true;
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
  };
}
