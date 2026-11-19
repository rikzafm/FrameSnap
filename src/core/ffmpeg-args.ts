/** ffmpeg command lines for downloads and GIFs. Pure: plan in, argv out. */
import { OUTPUT_META } from "./codecs";
import { gifDimensions } from "./estimate";
import type { GifOptions } from "./model";
import type { DownloadPlan, PlanInput } from "./plan";

export interface Seek {
  /** Seconds into the input file. */
  start: number;
  /** Seconds to keep. */
  length: number;
}

export interface EngineInput {
  file: string;
  /** Container of the file as written to the engine FS (concatenated TS stays "ts"). */
  container: PlanInput["container"];
}

const n = (x: number) => x.toFixed(3);

function seekArgs(seek: Seek | undefined): string[] {
  return seek ? ["-ss", n(seek.start), "-t", n(seek.length)] : [];
}

function videoCodecArgs(plan: DownloadPlan): string[] {
  if (plan.video === "drop") return ["-vn"];
  if (plan.video === "copy") return ["-c:v", "copy"];
  return plan.output.format === "webm"
    ? ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-crf", "33", "-b:v", "0"]
    : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"];
}

function audioCodecArgs(plan: DownloadPlan): string[] {
  if (plan.audio === "drop") return ["-an"];
  if (plan.audio === "copy") return ["-c:a", "copy"];
  switch (plan.output.format) {
    case "webm":
      return ["-c:a", "libopus", "-b:a", "128k"];
    case "mp3":
      return ["-c:a", "libmp3lame", "-q:a", "2"];
    default:
      return ["-c:a", "aac", "-b:a", "160k"];
  }
}

/**
 * Inputs are in plan order (video/muxed first, then separate audio).
 * `seek` is per input because a segment window starts at a different offset
 * in each track.
 */
export function buildDownloadArgs(plan: DownloadPlan, inputs: EngineInput[], output: string, seeks: (Seek | undefined)[] = []): string[] {
  const args: string[] = ["-hide_banner", "-nostdin"];
  inputs.forEach((input, i) => {
    args.push(...seekArgs(seeks[i]), "-i", input.file);
  });

  const audioIndex = inputs.length > 1 ? 1 : 0;
  if (plan.video !== "drop") args.push("-map", "0:v:0");
  if (plan.audio !== "drop") args.push("-map", `${audioIndex}:a:0?`);

  args.push(...videoCodecArgs(plan), ...audioCodecArgs(plan));

  const fmt = plan.output.format;
  const mp4Family = fmt === "mp4" || fmt === "mov" || fmt === "m4a";
  if (plan.audio === "copy" && mp4Family && inputs[audioIndex]?.container === "ts") args.push("-bsf:a", "aac_adtstoasc");
  if (mp4Family) args.push("-movflags", "+faststart");
  // copy-mode trims start on a keyframe; shift timestamps so the file starts at 0
  if (plan.trim) args.push("-avoid_negative_ts", "make_zero");

  args.push("-f", OUTPUT_META[fmt].ffmpegFormat, "-y", output);
  return args;
}

/** ffmpeg -loop: 0 = forever, -1 = play once, N = repeat N more times. Ours: total plays, 0 = forever. */
export function gifLoopFlag(plays: number): number {
  if (plays <= 0) return 0;
  return plays === 1 ? -1 : plays - 1;
}

export interface GifCommands {
  palette: string;
  pass1: string[];
  pass2: string[];
}

export function buildGifArgs(opts: GifOptions, input: string, output: string, src: { width: number; height: number }, seek: Seek): GifCommands {
  const { width } = gifDimensions(opts, src.width, src.height);
  const palette = "palette.png";
  // "source" keeps the clip's own frames: a GIF that a site turned into MP4 already has GIF timing
  const scale = `scale=${width}:-2:flags=lanczos`;
  const base = opts.fps === "source" ? scale : `fps=${opts.fps},${scale}`;
  const dither = opts.dither ? "sierra2_4a" : "none";
  return {
    palette,
    pass1: ["-hide_banner", "-nostdin", ...seekArgs(seek), "-i", input, "-vf", `${base},palettegen=stats_mode=diff`, "-y", palette],
    pass2: [
      "-hide_banner",
      "-nostdin",
      ...seekArgs(seek),
      "-i",
      input,
      "-i",
      palette,
      "-lavfi",
      `${base}[x];[x][1:v]paletteuse=dither=${dither}:diff_mode=rectangle`,
      "-loop",
      String(gifLoopFlag(opts.loop)),
      "-y",
      output,
    ],
  };
}
