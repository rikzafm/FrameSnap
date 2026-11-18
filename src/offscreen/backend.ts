/**
 * The ffmpeg runtime behind the engine. The browser uses @ffmpeg/ffmpeg
 * (a Web Worker around the bundled single-thread core); the Node engine
 * suite supplies a worker_threads implementation of the same interface.
 */
export interface FfmpegBackend {
  load(): Promise<void>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  deleteFile(path: string): Promise<void>;
  /** Resolves with ffmpeg's exit code. */
  exec(args: string[]): Promise<number>;
  /** Progress reported by ffmpeg while exec() runs, 0..1 (may be unreliable with -t). */
  onProgress(cb: (ratio: number) => void): void;
  /** Kill the runtime immediately. load() must work again afterwards. */
  terminate(): void;
}
