/** Browser FfmpegBackend: @ffmpeg/ffmpeg driving the bundled single-thread core. */
import { FFmpeg } from '@ffmpeg/ffmpeg';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';
import type { FfmpegBackend } from './backend';

export class FfmpegWasmBackend implements FfmpegBackend {
  private ff?: FFmpeg;
  private progress: (r: number) => void = () => {};

  private get inst(): FFmpeg {
    if (!this.ff) throw new Error('ffmpeg is not loaded');
    return this.ff;
  }

  async load(): Promise<void> {
    const ff = new FFmpeg();
    ff.on('progress', ({ progress }) => this.progress(progress));
    this.ff = ff; // set first so terminate() during load() still kills the worker
    await ff.load({ coreURL, wasmURL });
  }
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    await this.inst.writeFile(path, data);
  }
  async readFile(path: string): Promise<Uint8Array> {
    return (await this.inst.readFile(path)) as Uint8Array;
  }
  async deleteFile(path: string): Promise<void> {
    await this.inst.deleteFile(path);
  }
  exec(args: string[]): Promise<number> {
    return this.inst.exec(args);
  }
  onProgress(cb: (ratio: number) => void): void {
    this.progress = cb;
  }
  terminate(): void {
    this.ff?.terminate();
    this.ff = undefined;
  }
}
