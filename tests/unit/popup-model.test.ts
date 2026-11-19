import { describe, expect, it } from "vitest";
import { describeDownload, jobRowModel, qualityChoices, resumeBanner } from "../../src/popup/model";
import { ERROR_COPY } from "../../src/core/errors";
import type { DownloadOptions, VideoSource } from "../../src/core/model";
import type { JobRecord } from "../../src/core/jobs/job";

const MB = 1024 * 1024;
function source(over: Partial<VideoSource> = {}): VideoSource {
  return {
    id: "s1",
    site: "reddit",
    title: "Cat falls: off/table",
    pageUrl: "https://example.com/p",
    duration: 60,
    variants: [
      { id: "v720", kind: "progressive", url: "https://c/720.mp4", container: "mp4", videoCodec: "avc1.64001f", audioCodec: "mp4a.40.2", height: 720, sizeBytes: 84 * MB, hasAudio: true },
      { id: "v1080", kind: "progressive", url: "https://c/1080.mp4", container: "mp4", videoCodec: "avc1.64001f", audioCodec: "mp4a.40.2", height: 1080, sizeBytes: 200 * MB, hasAudio: true },
    ],
    audioTracks: [],
    protection: "none",
    detectedBy: ["dom"],
    ...over,
  };
}
const opts = (o: Partial<DownloadOptions> = {}): DownloadOptions => ({ format: "mp4", quality: "best", audio: "keep", filenameTemplate: "{title}-{site}-{resolution}", ...o });
const date = new Date(2026, 0, 5);

describe("describeDownload: capture sources say why they are different", () => {
  const blob = (kind: "mse-capture" | "recorder") =>
    source({ variants: [{ id: "c1", kind, url: "blob:https://example.com/1", container: kind === "recorder" ? "webm" : "mp4", height: 720, hasAudio: true }] });

  it("recorder: real time, video must be playing, cannot resume", () => {
    const d = describeDownload(blob("recorder"), opts(), date);
    expect(d.warnings.map((w) => w.code)).toContain("capture-recorder");
    expect(d.warnings.find((w) => w.code === "capture-recorder")!.text).toMatch(/real time.*playing.*cannot be resumed/i);
  });

  it("MSE: only the buffered part, cannot resume", () => {
    const d = describeDownload(blob("mse-capture"), opts(), date);
    expect(d.warnings.find((w) => w.code === "capture-mse")!.text).toMatch(/buffered.*cannot be resumed/i);
  });
});

describe("describeDownload", () => {
  it("shows the estimate and a file name preview", () => {
    const d = describeDownload(source(), opts({ quality: "v720" }), date);
    expect(d.estimate).toBe("84 MB");
    expect(d.filename).toBe("Cat falls off table-reddit-720p.mp4");
    expect(d.warnings).toEqual([]);
  });
  it("marks approximate estimates", () => {
    const d = describeDownload(source(), opts({ quality: "v720", trim: { start: 0, end: 30 } }), date);
    expect(d.estimate).toBe("≈ 42 MB");
  });
  it("warns for large files and too-large conversions", () => {
    const big = source({ variants: [{ ...source().variants[0]!, id: "big", sizeBytes: 2000 * MB, container: "ts" }] });
    const d = describeDownload(big, opts({ format: "mkv" }), date);
    expect(d.warnings.map((w) => w.code)).toContain("large-file");
    expect(d.warnings.find((w) => w.code === "too-large")?.text).toBe(ERROR_COPY["too-large"].message);
  });
  it("hints when codecs were assumed", () => {
    const s = source({ variants: [{ id: "x", kind: "progressive", url: "u", container: "mp4", hasAudio: true, height: 480 }] });
    expect(describeDownload(s, opts(), date).warnings.map((w) => w.code)).toContain("assumed-codecs");
  });
  it("reports DRM as an error instead of throwing", () => {
    const d = describeDownload(source({ protection: "drm" }), opts(), date);
    expect(d.error?.code).toBe("drm");
  });
});

describe("qualityChoices", () => {
  it("lists best first, then heights descending", () => {
    expect(qualityChoices(source()).map((c) => c.label)).toEqual(["Best available", "1080p", "720p"]);
  });

  it("names the codec only where two variants share a height", () => {
    const v = (id: string, height: number, videoCodec: string) => ({ id, kind: "progressive" as const, url: `https://cdn/${id}`, container: "mp4" as const, height, videoCodec, hasAudio: false });
    const src = source({ variants: [v("a", 1080, "avc1.640028"), v("b", 1080, "vp9"), v("c", 1080, "av01.0.08M.08"), v("d", 720, "avc1.4d401f")] });
    expect(qualityChoices(src).map((c) => c.label)).toEqual(["Best available", "1080p · H.264", "1080p · VP9", "1080p · AV1", "720p"]);
  });
});

function job(over: Partial<JobRecord>): JobRecord {
  return { id: "j1", status: "failed", resumable: true, progress: 0.62, filename: "clip.mp4", updatedAt: 1, source: { pageUrl: "https://example.com/p", title: "Clip" }, ...over } as unknown as JobRecord;
}

describe("resumeBanner", () => {
  it("is absent with no resumable jobs", () => {
    expect(resumeBanner([])).toBeUndefined();
  });
  it("names the single job and its percent", () => {
    expect(resumeBanner([job({})])).toMatchObject({ text: "Download stopped at 62 %: Clip", jobIds: ["j1"], many: false });
  });
  it("collapses several jobs", () => {
    const b = resumeBanner([job({}), job({ id: "j2" })]);
    expect(b).toMatchObject({ text: "2 downloads can be resumed", many: true });
  });
});

describe("jobRowModel", () => {
  const run = { jobId: "j", title: "T", status: "running" as const, ratio: 0.256 };
  it("shows phase and percent while running", () => {
    expect(jobRowModel({ ...run, phase: "fetch" })).toMatchObject({ label: "Downloading", percent: 26, actions: ["cancel"] });
    expect(jobRowModel({ ...run, phase: "engine" }).label).toBe("Converting");
    expect(jobRowModel({ ...run, phase: "save" }).label).toBe("Saving");
  });
  it("offers Resume with kept percent for resumable failures", () => {
    const m = jobRowModel({ jobId: "j", title: "T", status: "failed", phase: "fetch", ratio: 0, error: { code: "network", message: ERROR_COPY.network.message, retryable: true }, resumable: true, keptRatio: 0.62 });
    expect(m.message).toBe(ERROR_COPY.network.message);
    expect(m.actions).toEqual(["resume"]);
    expect(m.resumeLabel).toBe("Resume (62 % kept)");
  });
  it("offers Retry for retryable non-resumable failures and nothing for fatal", () => {
    const base = { jobId: "j", title: "T", status: "failed" as const, phase: "fetch" as const, ratio: 0, resumable: false, keptRatio: 0 };
    expect(jobRowModel({ ...base, error: { code: "oom", message: "m", retryable: true } }).actions).toEqual(["retry"]);
    expect(jobRowModel({ ...base, error: { code: "drm", message: "m", retryable: false } }).actions).toEqual([]);
  });
});
