/**
 * A real, playable H.264/AAC clip for the e2e fixture, generated once with the same ffmpeg.wasm
 * (in Node) the engine tests use, then cached in the OS temp folder.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../../src/offscreen/engine';
import { NodeBackend } from '../helpers/node-backend';

export const CLIP = { width: 1920, height: 1080, seconds: 6, fps: 10 };

/**
 * Appends one ISO-BMFF `free` box so the file reaches `target` bytes. The moov box stays in
 * front (faststart), so players and the sniffer read the duration from the first bytes.
 */
export function padMp4(clip: Uint8Array, target: number): Uint8Array {
  if (clip.length >= target) return clip;
  const out = new Uint8Array(target);
  out.set(clip);
  const size = target - clip.length;
  new DataView(out.buffer).setUint32(clip.length, size);
  out.set([0x66, 0x72, 0x65, 0x65], clip.length + 4);
  return out;
}

let memo: Promise<Uint8Array> | undefined;

/** The unpadded clip: CLIP.seconds of test pattern plus a tone. */
export function makeClip(): Promise<Uint8Array> {
  memo ??= (async () => {
    const cache = join(
      tmpdir(),
      `framesnap-e2e-clip-${CLIP.width}x${CLIP.height}-${CLIP.seconds}s.mp4`,
    );
    if (existsSync(cache)) return new Uint8Array(readFileSync(cache));
    const backend = new NodeBackend();
    try {
      const blob = await new Engine(backend).encode(
        {
          inputs: [],
          commands: [
            [
              '-hide_banner',
              '-nostdin',
              '-f',
              'lavfi',
              '-i',
              `testsrc=duration=${CLIP.seconds}:size=${CLIP.width}x${CLIP.height}:rate=${CLIP.fps}`,
              '-f',
              'lavfi',
              '-i',
              `sine=frequency=440:duration=${CLIP.seconds}`,
              '-c:v',
              'libx264',
              '-preset',
              'ultrafast',
              '-pix_fmt',
              'yuv420p',
              '-c:a',
              'aac',
              '-movflags',
              '+faststart',
              '-y',
              'clip.mp4',
            ],
          ],
          output: 'clip.mp4',
          mime: 'video/mp4',
        },
        () => {},
        new AbortController().signal,
      );
      const bytes = new Uint8Array(await blob.arrayBuffer());
      writeFileSync(cache, bytes);
      return bytes;
    } finally {
      backend.terminate();
    }
  })();
  return memo;
}
