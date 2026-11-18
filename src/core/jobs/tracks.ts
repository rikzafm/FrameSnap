/**
 * Plan inputs + fetched manifests → concrete chunk lists and ffmpeg seeks.
 * The caller (service worker) does the I/O: HEAD probes and playlist fetches.
 */
import type { Seek } from "../ffmpeg-args";
import type { DashRepresentation } from "../media/dash";
import type { HlsMedia } from "../media/hls";
import { selectWindow } from "../media/window";
import type { DownloadPlan, PlanInput } from "../plan";
import { planByteChunks, planDashChunks, planHlsChunks, wholeChunk, type TrackPlan } from "./chunks";

export interface ProbeResult {
  totalBytes?: number;
  acceptsRanges: boolean;
  etag?: string;
  lastModified?: string;
}

export type ResolvedInput =
  | { kind: "progressive"; probe: ProbeResult }
  | { kind: "hls"; media: HlsMedia }
  | { kind: "dash"; rep: DashRepresentation; probe?: ProbeResult };

export interface BuiltTracks {
  tracks: TrackPlan[];
  /** One per input, for buildDownloadArgs. */
  seeks: (Seek | undefined)[];
}

export function buildTracks(plan: DownloadPlan, resolved: readonly ResolvedInput[]): BuiltTracks {
  if (resolved.length !== plan.inputs.length) throw new Error("buildTracks: one resolved entry per plan input");
  const tracks: TrackPlan[] = [];
  const seeks: (Seek | undefined)[] = [];

  plan.inputs.forEach((input: PlanInput, i) => {
    const r = resolved[i]!;
    const base = { trackId: String(i), role: input.role };

    if (r.kind === "progressive") {
      const chunks =
        r.probe.acceptsRanges && r.probe.totalBytes ? planByteChunks(input.url, r.probe.totalBytes) : wholeChunk(input.url, r.probe.totalBytes);
      tracks.push({ ...base, container: input.container, chunks, totalBytes: r.probe.totalBytes });
      // whole file fetched: trim is absolute
      seeks.push(plan.trim ? { start: plan.trim.start, length: plan.trim.end - plan.trim.start } : undefined);
      return;
    }

    if (r.kind === "hls") {
      const w = selectWindow(r.media.segments, plan.trim);
      const chunks = planHlsChunks(w.segments);
      const totalBytes = chunks.every((c) => c.bytes !== undefined) ? chunks.reduce((s, c) => s + c.bytes!, 0) : undefined;
      tracks.push({ ...base, container: r.media.container, chunks, totalBytes });
      seeks.push(plan.trim ? { start: w.offset, length: w.length } : undefined);
      return;
    }

    const whole = r.rep.segments.length === 1 && r.rep.segments[0]!.key === "whole";
    if (whole) {
      const chunks = planDashChunks(r.rep, r.rep.segments, { totalBytes: r.probe?.totalBytes, acceptsRanges: r.probe?.acceptsRanges ?? false });
      tracks.push({ ...base, container: "mp4", chunks, totalBytes: r.probe?.totalBytes });
      seeks.push(plan.trim ? { start: plan.trim.start, length: plan.trim.end - plan.trim.start } : undefined);
      return;
    }
    const w = selectWindow(r.rep.segments, plan.trim);
    tracks.push({ ...base, container: "fmp4", chunks: planDashChunks(r.rep, w.segments) });
    seeks.push(plan.trim ? { start: w.offset, length: w.length } : undefined);
  });

  return { tracks, seeks };
}

/** Parse the headers of a HEAD (or `Range: bytes=0-0`) response. */
export function probeFromHeaders(status: number, headers: Headers): ProbeResult {
  const contentRange = headers.get("Content-Range");
  const fromRange = contentRange ? /\/(\d+)\s*$/.exec(contentRange)?.[1] : undefined;
  const length = headers.get("Content-Length");
  const totalBytes = fromRange ? Number(fromRange) : status === 200 && length ? Number(length) : undefined;
  return {
    totalBytes: totalBytes && totalBytes > 0 ? totalBytes : undefined,
    acceptsRanges: status === 206 || /bytes/i.test(headers.get("Accept-Ranges") ?? ""),
    etag: headers.get("ETag") ?? undefined,
    lastModified: headers.get("Last-Modified") ?? undefined,
  };
}
