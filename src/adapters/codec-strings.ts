import { audioFamily, videoFamily } from "../core/codecs";

/** "avc1.64001f,mp4a.40.2" → the raw video and audio codec strings. */
export function splitCodecString(codecs: string | undefined): { video?: string; audio?: string } {
  const out: { video?: string; audio?: string } = {};
  for (const part of (codecs ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!out.video && videoFamily(part) !== "unknown") out.video = part;
    else if (!out.audio && audioFamily(part) !== "unknown") out.audio = part;
  }
  return out;
}
