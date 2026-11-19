/**
 * planDownload: the §F2 decision table as one pure function.
 *
 *   source + chosen options  →  which inputs to fetch, how to fetch them
 *                               (route), what ffmpeg does to each stream,
 *                               and whether the job can be resumed.
 */
import {
  OUTPUT_META,
  assumedFamilies,
  audioFamily,
  audioFits,
  containerMatches,
  isAudioFormat,
  splitCodecs,
  videoFamily,
  videoFits,
  type AudioFamily,
  type VideoFamily,
} from "./codecs";
import { FrameSnapError } from "./errors";
import { estimateDownloadBytes, type SizeEstimate } from "./estimate";
import { LARGE_FILE_BYTES, isGifImage, type AudioTrack, type Container, type DownloadOptions, type OutputFormat, type TrimRange, type Variant, type VariantKind, type VideoSource } from "./model";
import { bestVariant, qualityLines } from "./rank";

/** Progressive files at or above this size go through the resumable chunked route. */
export const CHUNKED_MIN_BYTES = 50 * 1024 * 1024;
/** Hard stop for anything that must pass through ffmpeg.wasm (≈2 GB heap, minus working room). */
export const ENGINE_MAX_BYTES = 1.6 * 1024 * 1024 * 1024;

/**
 * direct   – chrome.downloads fetches the URL itself. Fast, not resumable.
 * chunked  – extension fetches 8 MB byte ranges into the chunk store. Resumable.
 * segments – HLS/DASH segments into the chunk store. Resumable unless live.
 * capture  – MSE capture / MediaRecorder; bytes come from the page session.
 */
export type Route = "direct" | "chunked" | "segments" | "capture";
export type StreamOp = "copy" | "encode" | "drop";

export interface PlanInput {
  role: "video" | "audio" | "muxed";
  kind: VariantKind;
  url: string;
  container: Container;
  /** Variant or audio-track id this input came from. */
  refId: string;
  acceptsRanges: boolean;
  /** Ranged chunks beat one long request (see Variant.throttled). */
  throttled?: boolean;
  sizeBytes?: number;
  live: boolean;
}

export type PlanWarning = "large-file" | "too-large" | "assumed-codecs" | "capture-recorder" | "capture-mse";

export interface DownloadPlan {
  route: Route;
  inputs: PlanInput[];
  video: StreamOp;
  audio: StreamOp;
  /** False only for direct routes and chunked copies that need no remux. */
  needsEngine: boolean;
  output: { format: OutputFormat; extension: string; mime: string };
  trim?: TrimRange;
  frameAccurate: boolean;
  resumable: boolean;
  notResumableReason?: "direct" | "live" | "capture";
  estimate?: SizeEstimate;
  warnings: PlanWarning[];
  /** The chosen video's "720p" (short side, see `qualityLines`), for labels and {resolution} in file names. */
  height?: number;
}

function toInput(role: PlanInput["role"], v: Variant): PlanInput {
  return {
    role,
    kind: v.kind,
    url: v.url,
    container: v.container,
    refId: v.id,
    acceptsRanges: v.acceptsRanges === true,
    ...(v.throttled ? { throttled: true } : {}),
    sizeBytes: v.sizeBytes,
    live: v.live === true,
  };
}

function audioInput(t: AudioTrack): PlanInput {
  return {
    role: "audio",
    kind: t.kind,
    url: t.url,
    container: t.kind === "progressive" ? "mp4" : "unknown",
    refId: t.id,
    acceptsRanges: false,
    sizeBytes: t.sizeBytes,
    live: false,
  };
}

/** Video codecs in the order "best" prefers them for each output, among those that copy without re-encoding. */
const PREFERRED_VIDEO: Partial<Record<OutputFormat, VideoFamily[]>> = {
  mp4: ["h264", "hevc", "av1"],
  mov: ["h264", "hevc"],
  webm: ["vp9", "av1", "vp8"],
  mkv: ["h264", "vp9", "hevc", "av1", "vp8"],
};

/**
 * What "Best available" means for an output format: the tallest variant whose
 * video goes into it as is (YouTube's 1080p VP9 into MP4 would be re-encoded
 * in the browser, slowly, while its 1080p H.264 is copied). Ties go to the
 * format's preferred codec, then bitrate. With nothing that fits, or for an
 * audio format, it is simply the best variant.
 */
export function bestVariantFor(variants: readonly Variant[], format: OutputFormat): Variant | undefined {
  const order = PREFERRED_VIDEO[format];
  if (!order) return bestVariant(variants);
  const rank = (v: Variant) => order.indexOf(families(v).video);
  const fitting = variants.filter((v) => rank(v) >= 0 && videoFits(families(v).video, format));
  if (!fitting.length) return bestVariant(variants);
  return [...fitting].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || rank(a) - rank(b) || (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
}

function pickVariant(source: VideoSource, quality: string, format: OutputFormat): Variant {
  const v = (quality !== "best" && source.variants.find((x) => x.id === quality)) || bestVariantFor(source.variants, format);
  if (!v) throw new FrameSnapError("unsupported", "no playable variant");
  return v;
}

function bestAudioTrack(tracks: readonly AudioTrack[]): AudioTrack | undefined {
  return [...tracks].sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
}

function families(v: Variant): { video: VideoFamily; audio: AudioFamily; assumed: boolean } {
  const fromCodec = { video: videoFamily(v.videoCodec), audio: audioFamily(v.audioCodec) };
  if (fromCodec.video !== "unknown" || fromCodec.audio !== "unknown") return { ...fromCodec, assumed: false };
  const fromString = splitCodecs([v.videoCodec, v.audioCodec].filter(Boolean).join(","));
  if (fromString.video !== "unknown") return { ...fromString, assumed: false };
  return { ...assumedFamilies(v.container), assumed: true };
}

function opFor(fits: boolean, frameAccurate: boolean): StreamOp {
  return fits && !frameAccurate ? "copy" : "encode";
}

/**
 * A GIF image is saved as the file the page shows: chrome.downloads fetches it
 * as is, so no frame, colour or timing is touched. Format, audio and trim do
 * not apply.
 */
function planGifImage(source: VideoSource, opts: DownloadOptions): DownloadPlan {
  const chosen = (opts.quality !== "best" && source.variants.find((v) => v.id === opts.quality)) || bestVariant(source.variants) || source.variants[0]!;
  return {
    route: "direct",
    inputs: [toInput("video", chosen)],
    video: "copy",
    audio: "drop",
    needsEngine: false,
    output: { format: "gif", extension: OUTPUT_META.gif.extension, mime: OUTPUT_META.gif.mime },
    frameAccurate: false,
    resumable: false,
    notResumableReason: "direct",
    estimate: chosen.sizeBytes !== undefined ? { bytes: chosen.sizeBytes, confidence: "exact" } : undefined,
    warnings: [],
    height: qualityLines(chosen),
  };
}

export function planDownload(source: VideoSource, opts: DownloadOptions): DownloadPlan {
  if (source.protection === "drm") throw new FrameSnapError("drm");
  if (isGifImage(source)) return planGifImage(source, opts);
  if (opts.format === "gif") {
    // the original upload behind a site's MP4 rendition
    if (source.gifUrl) {
      const like = bestVariant(source.variants);
      const original: Variant = { id: "gif:original", kind: "progressive", url: source.gifUrl, container: "gif", hasAudio: false, ...(like?.width ? { width: like.width } : {}), ...(like?.height ? { height: like.height } : {}) };
      return planGifImage({ ...source, variants: [original] }, { ...opts, quality: original.id });
    }
    throw new FrameSnapError("unsupported", "this video has no .gif file to save");
  }

  // "Audio only" always means an audio file; an audio format always means audio only.
  const format: OutputFormat = opts.audio === "only" && !isAudioFormat(opts.format) ? "m4a" : opts.format;
  const audioOnly = isAudioFormat(format);
  const trim = opts.trim && opts.trim.end > opts.trim.start ? opts.trim : undefined;
  const frameAccurate = Boolean(trim && opts.frameAccurate);
  const warnings: PlanWarning[] = [];

  const inputs: PlanInput[] = [];
  let videoOp: StreamOp = "drop";
  let audioOp: StreamOp = "drop";
  let chosen: Variant | undefined;

  if (audioOnly) {
    const track = bestAudioTrack(source.audioTracks);
    if (track) {
      inputs.push(audioInput(track));
      audioOp = opFor(audioFits(audioFamily(track.codec), format), frameAccurate);
    } else {
      // smallest muxed rendition that has sound
      const muxed = source.variants.filter((v) => v.hasAudio).sort((a, b) => (a.bitrate ?? a.height ?? 0) - (b.bitrate ?? b.height ?? 0))[0];
      if (!muxed) throw new FrameSnapError("unsupported", "this video has no audio");
      inputs.push(toInput("muxed", muxed));
      const f = families(muxed);
      if (f.assumed) warnings.push("assumed-codecs");
      audioOp = opFor(audioFits(f.audio, format), frameAccurate);
    }
  } else {
    chosen = pickVariant(source, opts.quality, format);
    const f = families(chosen);
    if (f.assumed) warnings.push("assumed-codecs");
    videoOp = opFor(videoFits(f.video, format), frameAccurate);

    if (opts.audio === "keep") {
      if (chosen.hasAudio) {
        inputs.push(toInput("muxed", chosen));
        audioOp = opFor(audioFits(f.audio, format), frameAccurate);
      } else {
        inputs.push(toInput("video", chosen));
        const track = bestAudioTrack(source.audioTracks);
        if (track) {
          inputs.push(audioInput(track));
          audioOp = opFor(audioFits(audioFamily(track.codec), format), frameAccurate);
        }
      }
    } else {
      inputs.push(toInput(chosen.hasAudio ? "muxed" : "video", chosen));
    }
  }

  const first = inputs[0]!;
  const kinds = new Set(inputs.map((i) => i.kind));
  const removesAudio = !audioOnly && opts.audio === "remove" && first.role === "muxed";
  const needsEngine =
    inputs.length > 1 ||
    first.kind !== "progressive" ||
    trim !== undefined ||
    videoOp === "encode" ||
    audioOp === "encode" ||
    removesAudio ||
    audioOnly ||
    !containerMatches(first.container, format);

  let route: Route;
  if (kinds.has("mse-capture") || kinds.has("recorder")) route = "capture";
  else if (kinds.has("hls") || kinds.has("dash")) route = "segments";
  else if (needsEngine) route = "chunked";
  else route = first.acceptsRanges && ((first.sizeBytes ?? 0) >= CHUNKED_MIN_BYTES || first.throttled === true) ? "chunked" : "direct";

  if (kinds.has("recorder")) warnings.push("capture-recorder");
  else if (kinds.has("mse-capture")) warnings.push("capture-mse");

  let notResumableReason: DownloadPlan["notResumableReason"];
  if (route === "direct") notResumableReason = "direct";
  else if (route === "capture") notResumableReason = "capture";
  else if (inputs.some((i) => i.live)) notResumableReason = "live";

  const audioBytes = inputs.find((i) => i.role === "audio")?.sizeBytes;
  const estimate = estimateDownloadBytes(audioOnly ? undefined : chosen, audioBytes, source.duration, trim);
  if (estimate && estimate.bytes > LARGE_FILE_BYTES) warnings.push("large-file");
  if (estimate && needsEngine && estimate.bytes > ENGINE_MAX_BYTES) warnings.push("too-large");

  return {
    route,
    inputs,
    video: videoOp,
    audio: audioOp,
    needsEngine,
    output: { format, extension: OUTPUT_META[format].extension, mime: OUTPUT_META[format].mime },
    trim,
    frameAccurate,
    resumable: notResumableReason === undefined,
    notResumableReason,
    estimate,
    warnings,
    height: chosen && qualityLines(chosen),
  };
}
