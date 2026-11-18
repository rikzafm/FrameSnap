/**
 * ffmpeg engine. One command line at a time (the single-thread core cannot
 * overlap jobs), runs queued. Cancelling terminates the runtime outright;
 * the next job reloads a fresh one, so a cancelled encode never leaks state.
 */
import { FrameSnapError } from '../core/errors';
import type { FfmpegBackend } from './backend';

export interface EncodeJob {
  /** Written to the engine FS before the first command. */
  inputs: { name: string; blob: Blob }[];
  /** Run in order (a GIF is two: palette, then render). */
  commands: string[][];
  /** File name the last command writes. */
  output: string;
  mime: string;
  /** Intermediate files (the GIF palette) removed afterwards. */
  scratch?: string[];
}

export type ProgressFn = (ratio: number) => void;

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

export class Engine {
  private ready?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly backend: FfmpegBackend) {}

  private load(): Promise<void> {
    this.ready ??= this.backend.load().catch((err) => {
      this.ready = undefined;
      throw err;
    });
    return this.ready;
  }

  private kill(): void {
    this.ready = undefined;
    this.backend.terminate();
  }

  /** Serialise work; a failed or cancelled job never blocks the next one. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Run `body` with `signal` wired to terminate the runtime. */
  private async guarded<T>(signal: AbortSignal, body: () => Promise<T>): Promise<T> {
    if (signal.aborted) throw new FrameSnapError('cancelled');
    const onAbort = () => this.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await this.load();
      return await body();
    } catch (err) {
      if (signal.aborted) throw new FrameSnapError('cancelled');
      if (err instanceof FrameSnapError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new FrameSnapError(/memory|alloc|oom/i.test(msg) ? 'oom' : 'internal', msg);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /** One ffmpeg command line against whatever is already in the engine FS. */
  run(args: string[], onProgress: ProgressFn, signal: AbortSignal): Promise<void> {
    return this.enqueue(() => this.guarded(signal, () => this.exec(args, onProgress)));
  }

  private async exec(args: string[], onProgress: ProgressFn): Promise<void> {
    this.backend.onProgress((r) => onProgress(clamp01(r)));
    const code = await this.backend.exec(args);
    if (code !== 0) throw new FrameSnapError('internal', `ffmpeg exited with code ${code}`);
  }

  /** Write inputs, run every command, read the output. Always clears the engine FS afterwards. */
  encode(job: EncodeJob, onProgress: ProgressFn, signal: AbortSignal): Promise<Blob> {
    return this.enqueue(() =>
      this.guarded(signal, async () => {
        const files = [...job.inputs.map((i) => i.name), job.output];
        try {
          for (const input of job.inputs)
            await this.backend.writeFile(
              input.name,
              new Uint8Array(await input.blob.arrayBuffer()),
            );
          const n = job.commands.length;
          for (const [i, args] of job.commands.entries()) {
            await this.exec(args, (r) => onProgress((i + r) / n));
          }
          const data = await this.backend.readFile(job.output);
          onProgress(1);
          return new Blob([data as Uint8Array<ArrayBuffer>], { type: job.mime });
        } finally {
          if (!signal.aborted)
            for (const f of [...files, ...(job.scratch ?? [])])
              await this.backend.deleteFile(f).catch(() => {});
        }
      }),
    );
  }
}
