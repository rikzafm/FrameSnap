/** Codec families and which containers can hold them without re-encoding. */
import type { Container, OutputFormat } from "./model";

export type VideoFamily = "h264" | "hevc" | "vp8" | "vp9" | "av1" | "unknown";
export type AudioFamily = "aac" | "mp3" | "opus" | "vorbis" | "ac3" | "unknown";

export function videoFamily(codec: string | undefined): VideoFamily {
  const c = (codec ?? "").toLowerCase();
  if (/^(avc[1-4]|h264)/.test(c)) return "h264";
  if (/^(hvc1|hev1|hevc|h265)/.test(c)) return "hevc";
  if (/^(vp09|vp9)/.test(c)) return "vp9";
  if (/^(vp08|vp8)/.test(c)) return "vp8";
  if (/^(av01|av1)/.test(c)) return "av1";
  return "unknown";
}

export function audioFamily(codec: string | undefined): AudioFamily {
  const c = (codec ?? "").toLowerCase();
  if (/^(mp4a\.40|aac)/.test(c)) return "aac";
  if (/^(mp4a\.6b|mp4a\.69|mp3)/.test(c)) return "mp3";
  if (/^opus/.test(c)) return "opus";
  if (/^vorbis/.test(c)) return "vorbis";
  if (/^(ac-3|ec-3|ac3|eac3)/.test(c)) return "ac3";
  return "unknown";
}

/**
 * Codec strings from codecs="avc1.64001f,mp4a.40.2" (HLS/DASH/MIME) → families.
 */
export function splitCodecs(codecs: string | undefined): { video: VideoFamily; audio: AudioFamily } {
  let video: VideoFamily = "unknown";
  let audio: AudioFamily = "unknown";
  for (const part of (codecs ?? "").split(",").map((s) => s.trim())) {
    if (video === "unknown" && videoFamily(part) !== "unknown") video = videoFamily(part);
    if (audio === "unknown" && audioFamily(part) !== "unknown") audio = audioFamily(part);
  }
  return { video, audio };
}

/** When a source does not say, assume the usual codecs of its container. */
export function assumedFamilies(container: Container): { video: VideoFamily; audio: AudioFamily } {
  switch (container) {
    case "webm":
      return { video: "vp9", audio: "opus" };
    case "mp4":
    case "fmp4":
    case "ts":
      return { video: "h264", audio: "aac" };
    default:
      return { video: "unknown", audio: "unknown" };
  }
}

const VIDEO_OK: Record<OutputFormat, VideoFamily[]> = {
  mp4: ["h264", "hevc", "av1"],
  mov: ["h264", "hevc"],
  webm: ["vp8", "vp9", "av1"],
  mkv: ["h264", "hevc", "vp8", "vp9", "av1"],
  mp3: [],
  m4a: [],
};

const AUDIO_OK: Record<OutputFormat, AudioFamily[]> = {
  mp4: ["aac", "mp3", "opus", "ac3"],
  mov: ["aac", "mp3", "ac3"],
  webm: ["opus", "vorbis"],
  mkv: ["aac", "mp3", "opus", "vorbis", "ac3"],
  mp3: ["mp3"],
  m4a: ["aac"],
};

export function videoFits(family: VideoFamily, format: OutputFormat): boolean {
  return VIDEO_OK[format].includes(family);
}

export function audioFits(family: AudioFamily, format: OutputFormat): boolean {
  return AUDIO_OK[format].includes(family);
}

export function isAudioFormat(format: OutputFormat): format is "mp3" | "m4a" {
  return format === "mp3" || format === "m4a";
}

export const OUTPUT_META: Record<OutputFormat, { extension: string; mime: string; ffmpegFormat: string }> = {
  mp4: { extension: "mp4", mime: "video/mp4", ffmpegFormat: "mp4" },
  webm: { extension: "webm", mime: "video/webm", ffmpegFormat: "webm" },
  mkv: { extension: "mkv", mime: "video/x-matroska", ffmpegFormat: "matroska" },
  mov: { extension: "mov", mime: "video/quicktime", ffmpegFormat: "mov" },
  mp3: { extension: "mp3", mime: "audio/mpeg", ffmpegFormat: "mp3" },
  m4a: { extension: "m4a", mime: "audio/mp4", ffmpegFormat: "ipod" },
};

/** Output container that a progressive source already is, if any. */
export function containerMatches(container: Container, format: OutputFormat): boolean {
  return (container === "mp4" && format === "mp4") || (container === "webm" && format === "webm");
}
