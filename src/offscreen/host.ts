/**
 * The offscreen document's brain: takes commands from the service worker,
 * runs the resumable fetch phase and the ffmpeg engine, and reports back.
 * Everything environmental (OPFS, fetch, blob URLs, storage API) is injected
 * so the logic is testable without a browser.
 */
import { FrameSnapError, appError, toAppError, type AppError } from '../core/errors';
import type {
  EngineToWorker,
  EngineTrackRef,
  StorageReport,
  WorkerToEngine,
} from '../core/engine-messages';
import { buildDownloadArgs, buildGifArgs, type EngineInput } from '../core/ffmpeg-args';
import { runFetchPhase, type FetchPhaseOptions, type HttpGet } from '../core/jobs/fetch-loop';
import { selectEvictions, storeCap } from '../core/jobs/cleanup';
import { assembleTrack, type ChunkStore } from '../core/jobs/store';
import type { Container } from '../core/model';
import type { Engine } from './engine';

export interface EngineHostDeps {
  send: (m: EngineToWorker) => void;
  /** The persistent store. May throw if OPFS is unavailable. */
  opfs: () => ChunkStore;
  /** Non-persistent fallback shared by every job that lost OPFS. */
  memory: ChunkStore;
  engine: Engine;
  http: HttpGet;
  blobUrls: { create(b: Blob): string; revoke(url: string): void };
  storage: { persist(): Promise<boolean>; estimate(): Promise<{ usage?: number; quota?: number }> };
  /** Test hook: sleep/backoff/concurrency passed to runFetchPhase. */
  fetchTuning?: Pick<FetchPhaseOptions, 'sleep' | 'backoffMs' | 'retries' | 'concurrency'>;
}

export interface EngineHost {
  connect(): Promise<void>;
  handle(msg: WorkerToEngine): Promise<void>;
}

/** Failures that mean "this storage cannot hold the chunks", as opposed to network or protocol errors. */
function isStorageError(err: unknown): boolean {
  if (err instanceof FrameSnapError) return err.appError.code === 'quota';
  return err instanceof DOMException && err.name !== 'AbortError';
}

export function createEngineHost(deps: EngineHostDeps): EngineHost {
  const { send, engine } = deps;
  const controllers = new Map<string, AbortController>();
  /** Jobs whose chunks live in memory because OPFS failed. */
  const inMemory = new Set<string>();
  let persisted: boolean | undefined;

  const storeFor = (jobId: string): ChunkStore => {
    if (inMemory.has(jobId)) return deps.memory;
    try {
      return deps.opfs();
    } catch {
      inMemory.add(jobId);
      return deps.memory;
    }
  };

  /** Drop every stored chunk of a job. */
  const forget = async (jobId: string): Promise<void> => {
    await deps.memory.deleteJob(jobId);
    inMemory.delete(jobId);
    try {
      await deps.opfs().deleteJob(jobId);
    } catch {
      // OPFS unavailable: nothing was stored there
    }
  };

  /** What each controlled job is doing, for `engine/status`. */
  const phases = new Map<string, 'fetch' | 'engine'>();

  const begin = (jobId: string, phase: 'fetch' | 'engine'): AbortController => {
    controllers.get(jobId)?.abort();
    const ac = new AbortController();
    controllers.set(jobId, ac);
    phases.set(jobId, phase);
    return ac;
  };
  const end = (jobId: string, ac: AbortController) => {
    if (controllers.get(jobId) === ac) {
      controllers.delete(jobId);
      phases.delete(jobId);
    }
  };

  const fail = (jobId: string, err: unknown) => {
    const error: AppError =
      err instanceof Error && err.name === 'AbortError' ? appError('cancelled') : toAppError(err);
    send({ t: 'engine/error', jobId, error, resumable: error.retryable && !inMemory.has(jobId) });
  };

  async function storage(): Promise<StorageReport> {
    persisted ??= await deps.storage.persist().catch(() => false);
    const est = await deps.storage
      .estimate()
      .catch(() => ({}) as { usage?: number; quota?: number });
    return { usage: est.usage ?? 0, quota: est.quota ?? 0, persisted };
  }

  async function fetchPhase(msg: Extract<WorkerToEngine, { t: 'engine/fetch' }>): Promise<void> {
    const ac = begin(msg.jobId, 'fetch');
    if (msg.fresh) await forget(msg.jobId);
    // once byte totals are known they drive the ratio, so chunk counts must not pull it back
    let byteDriven = false;
    const run = (store: ChunkStore) =>
      runFetchPhase({
        jobId: msg.jobId,
        tracks: msg.tracks,
        store,
        http: deps.http,
        headers: msg.headers,
        validators: msg.validators,
        signal: ac.signal,
        ...deps.fetchTuning,
        onCommit: (trackId, key, bytes) =>
          send({ t: 'engine/commit', jobId: msg.jobId, trackId, key, bytes }),
        onBytes: (bytes, totalBytes) => {
          if (totalBytes) byteDriven = true;
          send({
            t: 'engine/progress',
            jobId: msg.jobId,
            phase: 'fetch',
            ratio: totalBytes ? Math.min(1, bytes / totalBytes) : 0,
            bytes,
            ...(totalBytes ? { totalBytes } : {}),
          });
        },
        onProgress: (done, total) =>
          !byteDriven &&
          send({
            t: 'engine/progress',
            jobId: msg.jobId,
            phase: 'fetch',
            ratio: total === 0 ? 1 : done / total,
          }),
      });
    try {
      try {
        await run(storeFor(msg.jobId));
      } catch (err) {
        if (ac.signal.aborted || inMemory.has(msg.jobId) || !isStorageError(err)) throw err;
        // OPFS refused (quota, blocked, unavailable): keep going in memory. Not resumable.
        inMemory.add(msg.jobId);
        await run(deps.memory);
      }
      send({ t: 'engine/fetched', jobId: msg.jobId, resumable: !inMemory.has(msg.jobId) });
    } catch (err) {
      fail(msg.jobId, ac.signal.aborted ? new DOMException('cancelled', 'AbortError') : err);
    } finally {
      end(msg.jobId, ac);
    }
  }

  async function encode(
    jobId: string,
    work: (signal: AbortSignal, onProgress: (r: number) => void) => Promise<{ blob: Blob }>,
  ): Promise<void> {
    const ac = begin(jobId, 'engine');
    try {
      const { blob } = await work(ac.signal, (ratio) =>
        send({ t: 'engine/progress', jobId, phase: 'engine', ratio }),
      );
      send({
        t: 'engine/result',
        jobId,
        url: deps.blobUrls.create(blob),
        bytes: blob.size,
        mime: blob.type,
      });
    } catch (err) {
      fail(jobId, err);
    } finally {
      end(jobId, ac);
    }
  }

  const assemble = (jobId: string, ref: EngineTrackRef, container: string, name: string) =>
    assembleTrack(storeFor(jobId), jobId, ref.trackId, ref.keys).then((blob) => ({
      name,
      blob,
      container,
    }));

  return {
    async connect() {
      send({ t: 'engine/ready', storage: await storage() });
    },

    async handle(msg) {
      switch (msg.t) {
        case 'engine/fetch':
          return fetchPhase(msg);

        case 'engine/download':
          return encode(msg.jobId, async (signal, onProgress) => {
            const { plan } = msg;
            const inputs: EngineInput[] = plan.inputs.map((input, i) => ({
              file: `in${i}.${input.container}`,
              container: input.container,
            }));
            const output = `out.${plan.output.extension}`;
            const files = await Promise.all(
              msg.tracks.map((ref, i) =>
                assemble(msg.jobId, ref, inputs[i]!.container, inputs[i]!.file),
              ),
            );
            const blob = await engine.encode(
              {
                inputs: files.map((f) => ({ name: f.name, blob: f.blob })),
                commands: [buildDownloadArgs(plan, inputs, output, msg.seeks)],
                output,
                mime: plan.output.mime,
              },
              onProgress,
              signal,
            );
            return { blob };
          });

        case 'engine/assemble':
          return encode(msg.jobId, async () => {
            const ref = msg.tracks[0]!;
            return {
              blob: await assembleTrack(storeFor(msg.jobId), msg.jobId, ref.trackId, ref.keys, msg.mime),
            };
          });

        case 'engine/gif':
          return encode(msg.jobId, async (signal, onProgress) => {
            const input = `in.${msg.track.container as Container}`;
            const cmds = buildGifArgs(msg.options, input, 'out.gif', msg.src, msg.seek);
            const file = await assemble(msg.jobId, msg.track, msg.track.container, input);
            const blob = await engine.encode(
              {
                inputs: [{ name: input, blob: file.blob }],
                commands: [cmds.pass1, cmds.pass2],
                output: 'out.gif',
                mime: 'image/gif',
                scratch: [cmds.palette],
              },
              onProgress,
              signal,
            );
            return { blob };
          });

        case 'engine/cancel':
          controllers.get(msg.jobId)?.abort();
          return;

        case 'engine/discard':
          controllers.get(msg.jobId)?.abort();
          await forget(msg.jobId);
          return;

        case 'engine/revoke':
          deps.blobUrls.revoke(msg.url);
          return;

        case 'engine/sweep': {
          const stored = await deps.opfs().jobs().catch(() => []);
          const { quota } = await storage();
          const evict = selectEvictions(stored, msg.records, msg.now, storeCap(quota || undefined));
          for (const id of evict) await deps.opfs().deleteJob(id).catch(() => undefined);
          send({ t: 'engine/swept', jobIds: evict });
          return;
        }

        case 'engine/storage':
          send({ t: 'engine/ready', storage: await storage() });
          return;

        case 'engine/status':
          send({
            t: 'engine/running',
            jobs: [...phases].map(([jobId, phase]) => ({ jobId, phase })),
          });
          return;
      }
    },
  };
}
