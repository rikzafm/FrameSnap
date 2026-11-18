/**
 * The whole resume algorithm, as the service worker runs it:
 * plan → tracks → fetch (fails) → record failed → page refresh (new signed
 * URLs) → re-detect → match → re-plan tracks → decide → fetch the rest.
 */
import { describe, expect, it } from "vitest";
import { runFetchPhase } from "../../src/core/jobs/fetch-loop";
import { commitChunks, decideResume, fail, newJob, recoverInterrupted, resumableOn, start, trackValidators, withTracks, fetchComplete } from "../../src/core/jobs/job";
import { canonicalPageUrl, makeSourceRef, matchSource } from "../../src/core/jobs/source-ref";
import { MemoryChunkStore, assembleTrack } from "../../src/core/jobs/store";
import { buildTracks } from "../../src/core/jobs/tracks";
import { toAppError } from "../../src/core/errors";
import type { DownloadOptions, VideoSource } from "../../src/core/model";
import { planDownload } from "../../src/core/plan";
import { FakeCdn, bytes, noSleep, sameBytes } from "../helpers/fake-cdn";

const MB = 1024 * 1024;
const SIZE = 60 * MB; // ≥ 50 MB with Range support → chunked, resumable

function detected(sig: string): VideoSource {
  return {
    id: "reddit:t3_abc",
    site: "reddit",
    title: "Clip from r/videos",
    pageUrl: "https://www.reddit.com/r/videos/comments/abc/clip/?utm_source=share",
    duration: 42,
    variants: [
      {
        id: "v720",
        kind: "progressive",
        url: `https://v.redd.it/abc/CMAF_720.mp4?sig=${sig}`,
        container: "mp4",
        videoCodec: "avc1.64001f",
        audioCodec: "mp4a.40.2",
        height: 720,
        bitrate: 2_500_000,
        hasAudio: true,
        acceptsRanges: true,
        sizeBytes: SIZE,
      },
    ],
    audioTracks: [],
    protection: "none",
    detectedBy: ["adapter"],
  };
}

const options: DownloadOptions = { format: "mp4", quality: "v720", audio: "keep", filenameTemplate: "{title}" };

describe("resume after a page refresh", () => {
  it("continues with the kept chunks and produces an identical file", async () => {
    const body = bytes(SIZE, 11);
    const cdn = new FakeCdn().put("/abc/CMAF_720.mp4", { body, etag: '"v1"' });
    cdn.validSigs.add("first");
    const store = new MemoryChunkStore();
    let now = 1_000;

    // ---- first attempt ----
    const source = detected("first");
    const plan = planDownload(source, options);
    expect(plan.route).toBe("chunked");
    expect(plan.resumable).toBe(true);

    const probe = { totalBytes: SIZE, acceptsRanges: true, etag: '"v1"' };
    const built = buildTracks(plan, [{ kind: "progressive", probe }]);
    const validators = built.tracks.map((t) => ({ plan: t, validators: trackValidators(t, { etag: probe.etag, contentLength: SIZE }) }));
    let job = start(
      withTracks(newJob({ id: "job1", kind: "download", filename: "clip.mp4", source: makeSourceRef(source, source.variants[0]), options, plan, now }), validators, now),
      now,
    );

    // signature expires after 3 chunks: the page was left open too long
    let served = 0;
    cdn.failures.push((path) => (path.endsWith(".mp4") && ++served > 3 ? 403 : undefined));
    const err = await runFetchPhase({
      jobId: job.id,
      tracks: built.tracks,
      store,
      http: cdn.http,
      validators: Object.fromEntries(validators.map((v) => [v.plan.trackId, v.validators])),
      signal: new AbortController().signal,
      concurrency: 1,
      sleep: noSleep,
      onCommit: (trackId, key) => (job = commitChunks(job, [{ trackId, key }], ++now)),
    }).catch((e) => e);
    job = fail(job, toAppError(err), ++now);

    expect(job.status).toBe("failed");
    expect(job.error?.code).toBe("expired");
    expect(job.resumable).toBe(true);
    expect(job.tracks[0]!.committed).toHaveLength(3);

    // ---- browser restarts, user refreshes the page ----
    const persisted = recoverInterrupted([JSON.parse(JSON.stringify(job))], ++now);
    const onPage = resumableOn(persisted, canonicalPageUrl("https://old.reddit.com/r/videos/comments/abc/clip#c1"));
    expect(onPage.map((j) => j.id)).toEqual(["job1"]);
    job = onPage[0]!;

    cdn.failures = [];
    cdn.log = [];
    cdn.validSigs.add("second");
    const fresh = detected("second");

    const match = matchSource(job.source, [fresh]);
    expect(match.status).toBe("found");
    const replan = planDownload(fresh, job.options as DownloadOptions);
    const rebuilt = buildTracks(replan, [{ kind: "progressive", probe }]);
    const freshTracks = rebuilt.tracks.map((t) => ({ plan: t, validators: trackValidators(t, { etag: '"v1"', contentLength: SIZE }) }));

    const decision = decideResume(job, match, freshTracks);
    expect(decision.action).toBe("continue");
    if (decision.action !== "continue") return;
    expect(decision.keptRatio).toBeCloseTo(3 / 8);

    job = start(job, ++now);
    const res = await runFetchPhase({
      jobId: job.id,
      tracks: rebuilt.tracks,
      store,
      http: cdn.http,
      validators: Object.fromEntries(freshTracks.map((v) => [v.plan.trackId, v.validators])),
      signal: new AbortController().signal,
      sleep: noSleep,
      onCommit: (trackId, key) => (job = commitChunks(job, [{ trackId, key }], ++now)),
    });

    expect(res.fetchedChunks).toBe(5);
    expect(cdn.bytesServed()).toBe(SIZE - 3 * 8 * MB);
    expect(cdn.log.every((l) => l.path === "/abc/CMAF_720.mp4" && l.status === 206)).toBe(true);
    expect(fetchComplete(job)).toBe(true);
    const out = new Uint8Array(await (await assembleTrack(store, job.id, "0", job.tracks[0]!.keys)).arrayBuffer());
    expect(sameBytes(out, body)).toBe(true);
  });

  it("restarts from zero when the file behind the post changed", () => {
    const source = detected("a");
    const plan = planDownload(source, options);
    const t1 = buildTracks(plan, [{ kind: "progressive", probe: { totalBytes: SIZE, acceptsRanges: true } }]).tracks;
    let job = withTracks(
      newJob({ id: "j", kind: "download", filename: "x.mp4", source: makeSourceRef(source, source.variants[0]), options, plan, now: 0 }),
      t1.map((t) => ({ plan: t, validators: trackValidators(t, { etag: '"v1"' }) })),
      0,
    );
    job = fail(commitChunks(job, [{ trackId: "0", key: t1[0]!.chunks[0]!.key }], 1), toAppError(new TypeError("x")), 2);

    const t2 = buildTracks(plan, [{ kind: "progressive", probe: { totalBytes: SIZE + 1, acceptsRanges: true } }]).tracks;
    const d = decideResume(job, matchSource(job.source, [detected("b")]), t2.map((t) => ({ plan: t, validators: trackValidators(t, { etag: '"v2"' }) })));
    expect(d).toEqual({ action: "restart", reason: "changed" });
  });

  it("asks the user to pick when the video cannot be identified", () => {
    const source = detected("a");
    const plan = planDownload(source, options);
    const job = newJob({ id: "j", kind: "download", filename: "x.mp4", source: makeSourceRef(source, source.variants[0]), options, plan, now: 0 });
    const other = { ...detected("b"), id: "reddit:t3_other", duration: 99 };
    expect(decideResume(job, matchSource(job.source, [other]), [])).toEqual({ action: "pick", reason: "not-found" });
  });
});
