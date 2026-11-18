/**
 * Download orchestrator (service worker side). One `job/download` goes
 * through: plan, route, probe or fetch manifests, build tracks, persist the
 * record, fetch (offscreen), run the engine, save, finish.
 *
 *   direct       chrome.downloads fetches the URL itself
 *   chunked /
 *   segments     the offscreen document fetches chunks into the chunk store,
 *                runs ffmpeg (or just assembles them) and hands back a blob:
 *                URL that chrome.downloads saves
 *
 * The orchestrator owns job records; the offscreen document owns bytes.
 * Everything chrome-specific is injected, so the whole flow runs in tests
 * against the real engine host.
 */
import { FrameSnapError, appError, httpError, toAppError, type AppError } from "../core/errors";
import type { EngineToWorker, WorkerToEngine } from "../core/engine-messages";
import type { Seek } from "../core/ffmpeg-args";
import { isAudioFormat } from "../core/codecs";
import { buildFilename } from "../core/filename";
import type { TrackPlan } from "../core/jobs/chunks";
import {
  cancel as cancelRecord,
  decideResume,
  enterPhase,
  fail as failRecord,
  fetchComplete,
  finish,
  newJob,
  recoverInterrupted,
  start as startRecord,
  trackValidators,
  withTracks,
  type JobRecord,
} from "../core/jobs/job";
import { canonicalPageUrl, makeSourceRef, matchSource, matchVariant, type MatchResult, type TrackValidators } from "../core/jobs/source-ref";
import { buildTracks, probeFromHeaders, type ProbeResult, type ResolvedInput } from "../core/jobs/tracks";
import type { JobEvent } from "../core/messages";
import { isMasterPlaylist, type parseMedia } from "../core/media/hls";
import type { parseMpd } from "../core/media/dash";
import type { DownloadOptions, Variant, VideoSource } from "../core/model";
import { planDownload, type DownloadPlan, type PlanInput } from "../core/plan";
import type { EngineLifecycle } from "./engine-lifecycle";
import type { JobStore } from "./job-store";

export interface Fetcher {
  (url: string, init: { method?: string; headers: Record<string, string>; signal: AbortSignal }): Promise<Response>;
}

export interface DownloadItem {
  id: number;
  filename?: string;
  canResume?: boolean;
}

export interface DownloadsApi {
  download(o: { url: string; filename: string; conflictAction: "uniquify" }): Promise<number>;
  search(q: { id: number }): Promise<DownloadItem[]>;
  resume(id: number): Promise<void>;
  cancel(id: number): Promise<void>;
  removeFile(id: number): Promise<void>;
  erase(q: { id: number }): Promise<unknown>;
}

export interface DnrApi {
  getSessionRules(): Promise<{ id: number }[]>;
  updateSessionRules(o: { addRules?: chrome.declarativeNetRequest.Rule[]; removeRuleIds?: number[] }): Promise<void>;
}

/** The subset of chrome.downloads.DownloadDelta the orchestrator reads. */
export interface DownloadDelta {
  id: number;
  state?: { current?: string };
  error?: { current?: string };
}

export interface HistoryEntry {
  id: string;
  kind: "download" | "gif" | "snap";
  title: string;
  site: string;
  pageUrl: string;
  filename: string;
  bytes?: number;
  /** The chrome.downloads id, for "Show in folder". */
  downloadId?: number;
  finishedAt: number;
}

export interface DownloadDeps {
  jobs: JobStore;
  /** Delivers a command to the offscreen document, creating it first if needed. */
  engine: { send(msg: WorkerToEngine): Promise<void> };
  lifecycle: EngineLifecycle;
  downloads: DownloadsApi;
  dnr: DnrApi;
  fetch: Fetcher;
  parseMedia: typeof parseMedia;
  parseMpd: typeof parseMpd;
  lookupSource(tabId: number, sourceId: string): Promise<VideoSource | undefined>;
  history: { add(entry: HistoryEntry): Promise<void> };
  emit(event: JobEvent): void;
  /** Resume: the sources currently detected on a tab (the registry). */
  listSources?(tabId: number): Promise<VideoSource[]>;
  /** Resume: the tab's URL, or undefined when the tab is gone. */
  tabUrl?(tabId: number): Promise<string | undefined>;
  /** Resume from History: open the job's page in a new tab and return its id. */
  openTab?(url: string): Promise<number>;
  /** How long resume waits for the registry to settle on the tab (default 5 s). */
  settleMs?: number;
  sleep?(ms: number): Promise<void>;
  now?: () => number;
  newId?: () => string;
}

export interface DownloadOrchestrator {
  /** Plan and start a job for a detected video. Resolves with the job id once the job is queued. */
  download(req: { tabId: number; sourceId: string; options: DownloadOptions }): Promise<string>;
  /** Same, for a source the caller already holds. */
  start(source: VideoSource, options: DownloadOptions): Promise<string>;
  cancel(jobId: string): Promise<void>;
  onEngineMessage(msg: EngineToWorker): Promise<void>;
  /** The engine port closed (offscreen document gone): fail what was running on it. */
  onEngineDisconnect(): Promise<void>;
  /** chrome.downloads.onChanged. */
  onDownloadChanged(delta: DownloadDelta): void;
  /** Resume a failed job on a tab (opens the job's page first when the tab is gone or shows another page). */
  resume(jobId: string, tabId: number): Promise<void>;
  /** The user picked the video by hand for a job that sent `resume-needs-pick`. */
  resumePicked(jobId: string, tabId: number, source: VideoSource): Promise<void>;
  /** Drop a job's chunks and record. */
  discard(jobId: string): Promise<void>;
  /** Service-worker start: jobs left queued or running become resumable failures. */
  recover(): Promise<void>;
  /** Chunk-store housekeeping (7-day expiry, orphans, cap). Resolves once the engine reported. */
  sweep(nowMs?: number): Promise<void>;
}

const POLL_MS = 250;

const MAX_DIRECT_RESUMES = 3;
const RULE_TYPES: chrome.declarativeNetRequest.ResourceType[] = ["xmlhttprequest", "media", "other"] as chrome.declarativeNetRequest.ResourceType[];

interface Active {
  id: string;
  source: VideoSource;
  plan: DownloadPlan;
  filename: string;
  ac: AbortController;
  /** What the offscreen document is doing for this job right now. */
  busy?: "fetch" | "engine" | "assemble";
  holdsEngine: boolean;
  usesEngine: boolean;
  cancelling: boolean;
  finalized: boolean;
  blobUrl?: string;
  blobBytes?: number;
  downloadId?: number;
  directResumes: number;
  ruleId?: number;
  seeks?: (Seek | undefined)[];
}

const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

const isAppError = (x: unknown): x is AppError =>
  typeof x === "object" && x !== null && !(x instanceof Error) && typeof (x as AppError).code === "string" && typeof (x as AppError).retryable === "boolean";

function downloadError(code: string | undefined): AppError {
  switch (code) {
    case "SERVER_FORBIDDEN":
    case "SERVER_UNAUTHORIZED":
    case "SERVER_BAD_CONTENT":
    case "SERVER_CERT_PROBLEM":
      return appError("expired", code);
    case "FILE_NO_SPACE":
    case "FILE_TOO_LARGE":
      return appError("quota", code);
    default:
      return appError("network", code ?? "download interrupted");
  }
}

export function createDownloadOrchestrator(deps: DownloadDeps): DownloadOrchestrator {
  const { jobs, downloads, dnr, lifecycle } = deps;
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const active = new Map<string, Active>();
  const byDownload = new Map<number, string>();
  /** Jobs whose fetch finished and wait for the single engine slot, FIFO. */
  const engineQueue: string[] = [];
  let engineOwner: string | undefined;
  let inbox: Promise<void> = Promise.resolve();
  let rulesChain: Promise<unknown> = Promise.resolve();
  const sweepWaiters: ((jobIds: string[]) => void)[] = [];
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const sameCanonical = (want: string) => (url: string | undefined) => {
    try {
      return url !== undefined && canonicalPageUrl(url) === want;
    } catch {
      return false;
    }
  };

  /** Read-modify-write on the stored record (commits arrive through the store, so never write a stale copy). */
  async function update(id: string, fn: (j: JobRecord) => JobRecord): Promise<JobRecord | undefined> {
    const cur = await jobs.get(id);
    if (!cur) return undefined;
    const next = fn(cur);
    await jobs.put(next);
    return next;
  }

  const keptRatio = (j: JobRecord | undefined): number => {
    if (!j) return 0;
    const total = j.tracks.reduce((s, t) => s + t.keys.length, 0);
    return total ? j.tracks.reduce((s, t) => s + t.committed.length, 0) / total : 0;
  };

  // ---- request header rules (Q7) -------------------------------------------------

  async function setRules(a: Active, urls: readonly string[]): Promise<void> {
    const headers = a.source.headers;
    if (!headers || Object.keys(headers).length === 0) return;
    const domains = [...new Set(urls.map(hostOf).filter((h): h is string => h !== undefined))];
    const run = rulesChain.then(async () => {
      if (a.ruleId === undefined) a.ruleId = Math.max(0, ...(await dnr.getSessionRules()).map((r) => r.id)) + 1;
      const rule: chrome.declarativeNetRequest.Rule = {
        id: a.ruleId,
        priority: 1,
        action: {
          type: "modifyHeaders" as chrome.declarativeNetRequest.RuleActionType,
          requestHeaders: Object.entries(headers).map(([header, value]) => ({
            header,
            operation: "set" as chrome.declarativeNetRequest.HeaderOperation,
            value,
          })),
        },
        condition: { requestDomains: domains, resourceTypes: RULE_TYPES },
      };
      await dnr.updateSessionRules({ removeRuleIds: [a.ruleId], addRules: [rule] });
    });
    rulesChain = run.catch(() => undefined);
    await run;
  }

  async function clearRules(a: Active): Promise<void> {
    const id = a.ruleId;
    if (id === undefined) return;
    a.ruleId = undefined;
    const run = rulesChain.then(() => dnr.updateSessionRules({ removeRuleIds: [id] }));
    rulesChain = run.catch(() => undefined);
    await run.catch(() => undefined);
  }

  // ---- probing -------------------------------------------------------------------

  const headersFor = (a: Active, extra: Record<string, string> = {}) => ({ ...(a.source.headers ?? {}), ...extra });

  async function fetchText(a: Active, url: string): Promise<string> {
    const res = await deps.fetch(url, { headers: headersFor(a), signal: a.ac.signal });
    if (!res.ok) throw httpError(res.status);
    return res.text();
  }

  /** `Range: bytes=0-0` tells size and Range support in one request; HEAD is the fallback. */
  async function probe(a: Active, url: string): Promise<ProbeResult> {
    const ranged = await deps.fetch(url, { headers: headersFor(a, { Range: "bytes=0-0" }), signal: a.ac.signal });
    void ranged.body?.cancel().catch(() => undefined);
    if (ranged.ok) return probeFromHeaders(ranged.status, ranged.headers);
    if (ranged.status === 401 || ranged.status === 403 || ranged.status === 404 || ranged.status === 410) throw httpError(ranged.status);
    const head = await deps.fetch(url, { method: "HEAD", headers: headersFor(a), signal: a.ac.signal });
    if (!head.ok) throw httpError(head.status);
    return probeFromHeaders(head.status, head.headers);
  }

  async function resolveInput(a: Active, input: PlanInput): Promise<{ resolved: ResolvedInput; http?: ProbeResult }> {
    switch (input.kind) {
      case "progressive": {
        const p = await probe(a, input.url);
        return { resolved: { kind: "progressive", probe: p }, http: p };
      }
      case "hls": {
        const text = await fetchText(a, input.url);
        if (isMasterPlaylist(text)) throw new FrameSnapError("unsupported", "expected a media playlist");
        const media = deps.parseMedia(text, input.url);
        if (media.protection === "drm") throw new FrameSnapError("drm");
        return { resolved: { kind: "hls", media } };
      }
      case "dash": {
        const mpd = deps.parseMpd(await fetchText(a, input.url), input.url);
        if (mpd.protection === "drm") throw new FrameSnapError("drm");
        const rep = [...mpd.video, ...mpd.audio].find((r) => r.id === input.refId);
        if (!rep) throw new FrameSnapError("not-found", "representation missing from the manifest");
        const whole = rep.segments.length === 1 && rep.segments[0]!.key === "whole";
        if (!whole) return { resolved: { kind: "dash", rep } };
        const p = await probe(a, rep.segments[0]!.url);
        return { resolved: { kind: "dash", rep, probe: p }, http: p };
      }
      default:
        throw new FrameSnapError("unsupported", `cannot fetch ${input.kind} inputs`);
    }
  }

  // ---- lifecycle helpers ---------------------------------------------------------

  function releaseEngine(a: Active): void {
    if (engineOwner === a.id) {
      engineOwner = undefined;
      void pump();
    }
    const at = engineQueue.indexOf(a.id);
    if (at >= 0) engineQueue.splice(at, 1);
  }

  async function settle(a: Active): Promise<void> {
    a.finalized = true;
    active.delete(a.id);
    if (a.downloadId !== undefined) byDownload.delete(a.downloadId);
    releaseEngine(a);
    await clearRules(a);
    if (a.blobUrl) {
      const url = a.blobUrl;
      a.blobUrl = undefined;
      await deps.engine.send({ t: "engine/revoke", url }).catch(() => undefined);
    }
    if (a.usesEngine) lifecycle.jobFinished(a.id);
  }

  async function failJob(a: Active, err: unknown, resumableOverride?: boolean): Promise<void> {
    if (a.finalized) return;
    const error = isAppError(err) ? err : toAppError(err);
    const rec = await update(a.id, (j) => {
      const failed = failRecord(j, error, now());
      return resumableOverride === false ? { ...failed, resumable: false } : failed;
    });
    const resumable = rec?.resumable ?? false;
    const kept = keptRatio(rec);
    await settle(a);
    if (!resumable && a.usesEngine) await deps.engine.send({ t: "engine/discard", jobId: a.id }).catch(() => undefined);
    deps.emit({ t: "failed", jobId: a.id, error, resumable, keptRatio: resumable ? kept : 0 });
  }

  async function finalizeCancel(a: Active): Promise<void> {
    if (a.finalized) return;
    const downloadId = a.downloadId;
    await update(a.id, (j) => cancelRecord(j, now()));
    await settle(a);
    if (a.usesEngine) await deps.engine.send({ t: "engine/discard", jobId: a.id }).catch(() => undefined);
    if (downloadId !== undefined) {
      await downloads.cancel(downloadId).catch(() => undefined);
      await downloads.removeFile(downloadId).catch(() => undefined);
      await downloads.erase({ id: downloadId }).catch(() => undefined);
    }
    deps.emit({ t: "cancelled", jobId: a.id });
  }

  async function complete(a: Active, downloadId: number): Promise<void> {
    if (a.finalized) return;
    const item = (await downloads.search({ id: downloadId }).catch(() => []))[0];
    const filename = item?.filename ? item.filename.split(/[\\/]/).pop() || a.filename : a.filename;
    const rec = await update(a.id, (j) => finish(j, downloadId, now()));
    const hadChunks = a.usesEngine;
    const bytes = a.blobBytes;
    await settle(a);
    if (hadChunks) await deps.engine.send({ t: "engine/discard", jobId: a.id }).catch(() => undefined);
    await deps.history
      .add({
        id: a.id,
        kind: "download",
        title: a.source.title,
        site: a.source.site,
        pageUrl: a.source.pageUrl,
        filename,
        downloadId,
        ...(bytes !== undefined ? { bytes } : {}),
        finishedAt: rec?.updatedAt ?? now(),
      })
      .catch(() => undefined);
    deps.emit({ t: "done", jobId: a.id, downloadId, filename });
  }

  // ---- saving --------------------------------------------------------------------

  async function save(a: Active, url: string): Promise<void> {
    await update(a.id, (j) => enterPhase(j, "save", now()));
    deps.emit({ t: "progress", jobId: a.id, phase: "save", ratio: 0 });
    const id = await downloads.download({ url, filename: a.filename, conflictAction: "uniquify" });
    a.downloadId = id;
    byDownload.set(id, a.id);
    if (a.cancelling) await finalizeCancel(a);
  }

  // ---- direct route --------------------------------------------------------------

  async function runDirect(a: Active): Promise<void> {
    const input = a.plan.inputs[0]!;
    await setRules(a, [input.url]);
    await update(a.id, (j) => enterPhase(startRecord(j, now()), "save", now()));
    await save(a, input.url);
  }

  // ---- engine routes -------------------------------------------------------------

  interface Prepared {
    tracks: TrackPlan[];
    seeks: (Seek | undefined)[];
    withValidators: { plan: TrackPlan; validators: TrackValidators }[];
  }

  /** Probe / parse the inputs and plan the chunks (fresh URLs, fresh validators). */
  async function prepareTracks(a: Active): Promise<Prepared> {
    await setRules(a, a.plan.inputs.map((i) => i.url));
    const resolved: Awaited<ReturnType<typeof resolveInput>>[] = [];
    for (const input of a.plan.inputs) resolved.push(await resolveInput(a, input));
    const built = buildTracks(
      a.plan,
      resolved.map((r) => r.resolved),
    );
    // the manifests know the real container (a plan input from a manifest only says "unknown")
    a.plan = { ...a.plan, inputs: a.plan.inputs.map((input, i) => ({ ...input, container: built.tracks[i]!.container })) };
    const withValidators = built.tracks.map((plan, i) => ({ plan, validators: trackValidators(plan, resolved[i]!.http) }));
    return { tracks: built.tracks as TrackPlan[], seeks: built.seeks, withValidators };
  }

  async function dispatchFetch(a: Active, p: Prepared, fresh: boolean): Promise<void> {
    a.seeks = p.seeks;
    await setRules(a, [...a.plan.inputs.map((i) => i.url), ...p.tracks.flatMap((t) => t.chunks.map((c) => c.url))]);
    a.ac.signal.throwIfAborted();
    a.busy = "fetch";
    const validators: Record<string, TrackValidators> = Object.fromEntries(p.withValidators.map((t) => [t.plan.trackId, t.validators]));
    await deps.engine.send({ t: "engine/fetch", jobId: a.id, tracks: p.tracks, headers: a.source.headers, validators, ...(fresh ? { fresh: true } : {}) });
  }

  async function runEngineRoute(a: Active): Promise<void> {
    a.usesEngine = true;
    lifecycle.jobStarted(a.id);
    const p = await prepareTracks(a);
    const plan = a.plan;
    await update(a.id, (j) => startRecord(withTracks({ ...j, plan }, p.withValidators, now()), now()));
    await dispatchFetch(a, p, false);
  }

  /** Resume: same job id, fresh tracks; keeps the committed chunks the decision allows. */
  async function runResume(a: Active, job: JobRecord, match: Extract<MatchResult, { status: "found" }>): Promise<void> {
    a.usesEngine = true;
    lifecycle.jobStarted(a.id);
    const p = await prepareTracks(a);
    const decision = decideResume(job, match, p.withValidators);
    if (decision.action === "pick") throw new FrameSnapError("not-found");
    const keep = decision.action === "continue" ? decision.keep : undefined;
    if (decision.action === "restart") deps.emit({ t: "notice", jobId: a.id, code: decision.reason });
    const plan = a.plan;
    const rec = await update(a.id, (j) => {
      const next = withTracks({ ...j, plan }, p.withValidators, now());
      const tracks = keep ? next.tracks.map((t) => ({ ...t, committed: keep.get(t.trackId) ?? [] })) : next.tracks;
      const total = tracks.reduce((s, t) => s + t.keys.length, 0);
      const done = tracks.reduce((s, t) => s + t.committed.length, 0);
      return startRecord({ ...next, tracks, progress: total ? done / total : 0 }, now());
    });
    if (!rec) throw new FrameSnapError("internal", "job record missing");
    deps.emit({ t: "progress", jobId: a.id, phase: "fetch", ratio: rec.progress });
    if (keep && fetchComplete(rec)) {
      // everything was fetched before the engine failed: skip the fetch phase
      a.seeks = p.seeks;
      a.ac.signal.throwIfAborted();
      await startEnginePhase(a);
      return;
    }
    await dispatchFetch(a, p, decision.action === "restart");
  }

  async function pump(): Promise<void> {
    if (engineOwner !== undefined) return;
    let next: Active | undefined;
    while (engineQueue.length > 0 && !next) {
      const a = active.get(engineQueue.shift()!);
      if (a && !a.cancelling) next = a;
    }
    if (!next) return;
    engineOwner = next.id;
    next.holdsEngine = true;
    next.busy = "engine";
    try {
      const rec = await update(next.id, (j) => enterPhase(j, "engine", now()));
      if (!rec) throw new FrameSnapError("internal", "job record missing");
      deps.emit({ t: "progress", jobId: next.id, phase: "engine", ratio: 0 });
      await deps.engine.send({
        t: "engine/download",
        jobId: next.id,
        plan: next.plan,
        tracks: rec.tracks.map((t) => ({ trackId: t.trackId, keys: t.keys })),
        seeks: next.seeks ?? [],
      });
    } catch (err) {
      await failJob(next, err);
    }
  }

  async function startEnginePhase(a: Active): Promise<void> {
    if (a.plan.needsEngine) {
      engineQueue.push(a.id);
      await pump();
      return;
    }
    // Chunks need no remux: join them into one file without ffmpeg.
    const rec = await update(a.id, (j) => enterPhase(j, "engine", now()));
    a.busy = "assemble";
    await deps.engine.send({
      t: "engine/assemble",
      jobId: a.id,
      mime: a.plan.output.mime,
      tracks: rec!.tracks.map((t) => ({ trackId: t.trackId, keys: t.keys })),
    });
  }

  async function handleEngine(m: EngineToWorker): Promise<void> {
    if (m.t === "engine/ready") return;
    if (m.t === "engine/swept") {
      for (const done of sweepWaiters.splice(0)) done(m.jobIds);
      return;
    }
    const a = active.get(m.jobId);
    if (!a || a.finalized) {
      // a result for a job we already gave up on: free the blob
      if (m.t === "engine/result") await deps.engine.send({ t: "engine/revoke", url: m.url }).catch(() => undefined);
      return;
    }
    switch (m.t) {
      case "engine/commit":
        jobs.commitChunks(a.id, [{ trackId: m.trackId, key: m.key }]);
        return;
      case "engine/progress":
        deps.emit({ t: "progress", jobId: a.id, phase: m.phase, ratio: m.ratio });
        return;
      case "engine/fetched":
        a.busy = undefined;
        if (a.cancelling) return finalizeCancel(a);
        if (!m.resumable) await update(a.id, (j) => ({ ...j, resumable: false }));
        return startEnginePhase(a);
      case "engine/result":
        a.busy = undefined;
        a.holdsEngine = false;
        releaseEngine(a);
        if (a.cancelling) {
          a.blobUrl = m.url;
          return finalizeCancel(a);
        }
        a.blobUrl = m.url;
        a.blobBytes = m.bytes;
        try {
          await save(a, m.url);
        } catch (err) {
          await failJob(a, err);
        }
        return;
      case "engine/error":
        a.busy = undefined;
        if (a.cancelling || m.error.code === "cancelled") return finalizeCancel(a);
        return failJob(a, m.error, m.resumable);
    }
  }

  // ---- public API ----------------------------------------------------------------

  async function startJob(source: VideoSource, options: DownloadOptions): Promise<string> {
    let plan: DownloadPlan;
    try {
      plan = planDownload(source, options);
      if (plan.warnings.includes("too-large")) throw new FrameSnapError("too-large");
    } catch (err) {
      // nothing was started: report it under a throwaway id
      const jobId = newId();
      deps.emit({ t: "failed", jobId, error: toAppError(err), resumable: false, keptRatio: 0 });
      return jobId;
    }
    const id = newId();
    const variant = source.variants.find((v) => v.id === plan.inputs[0]!.refId);
    const filename = buildFilename(
      options.filenameTemplate,
      { title: source.title, site: source.site, date: new Date(now()), height: plan.height, width: variant?.width },
      plan.output.extension,
    );
    const record = newJob({ id, kind: "download", filename, source: makeSourceRef(source, variant), options, plan, now: now() });
    await jobs.put(record);
    deps.emit({ t: "queued", jobId: id });

    const a: Active = {
      id,
      source,
      plan,
      filename,
      ac: new AbortController(),
      holdsEngine: false,
      usesEngine: false,
      cancelling: false,
      finalized: false,
      directResumes: 0,
    };
    active.set(id, a);
    void (plan.route === "direct" ? runDirect(a) : runEngineRoute(a)).catch(async (err) => {
      if (a.cancelling) return;
      await failJob(a, err);
    });
    return id;
  }

  // ---- resume ----------------------------------------------------------------------

  const audioOnly = (job: JobRecord) => {
    const o = job.options as DownloadOptions;
    return o.audio === "only" || isAudioFormat(o.format);
  };

  async function resumable(jobId: string): Promise<JobRecord | undefined> {
    const job = await jobs.get(jobId);
    if (!job || job.kind !== "download" || job.status !== "failed" || !job.resumable || active.has(jobId)) return undefined;
    return job;
  }

  /** Re-plan against the re-identified video and run the fetch-from-here pipeline. */
  async function continueWith(job: JobRecord, source: VideoSource, variant: Variant | undefined): Promise<void> {
    const stored = job.options as DownloadOptions;
    const options: DownloadOptions = variant ? { ...stored, quality: variant.id } : stored;
    const a: Active = {
      id: job.id,
      source,
      plan: job.plan,
      filename: job.filename,
      ac: new AbortController(),
      holdsEngine: false,
      usesEngine: false,
      cancelling: false,
      finalized: false,
      directResumes: 0,
    };
    active.set(job.id, a);
    try {
      a.plan = planDownload(source, options);
      if (!a.plan.resumable || a.plan.route === "direct") throw new FrameSnapError("unsupported", "this video can no longer be resumed");
      await runResume(a, job, { status: "found", source, variant, via: "id" });
    } catch (err) {
      if (a.cancelling) return;
      await failJob(a, err);
    }
  }

  async function resumeJob(jobId: string, tabId: number): Promise<void> {
    const job = await resumable(jobId);
    if (!job) return;
    let tab = tabId;
    let wait = deps.settleMs ?? 5000;
    const here = deps.tabUrl ? await deps.tabUrl(tabId).then(sameCanonical(job.source.pageUrl), () => false) : true;
    if (!here && deps.openTab) {
      tab = await deps.openTab(job.source.pageUrl);
      wait *= 3; // a fresh page needs time to load and be sniffed
    }
    const audio = audioOnly(job);
    let match: MatchResult;
    for (let waited = 0; ; waited += POLL_MS) {
      const sources = (await deps.listSources?.(tab).catch(() => undefined)) ?? [];
      match = matchSource(job.source, sources, audio);
      if (match.status === "found" || waited >= wait) break;
      await sleep(POLL_MS);
    }
    if (match.status !== "found") {
      deps.emit({ t: "resume-needs-pick", jobId });
      return;
    }
    await continueWith(job, match.source, match.variant);
  }

  async function resumePicked(jobId: string, tabId: number, picked: VideoSource): Promise<void> {
    const job = await resumable(jobId);
    if (!job) return;
    // prefer the registry's copy (manifests expanded) over the picker's snapshot
    const source = (await deps.listSources?.(tabId).catch(() => undefined))?.find((s) => s.id === picked.id) ?? picked;
    const variant = audioOnly(job) ? undefined : matchVariant(job.source.variant, source.variants);
    if (!audioOnly(job) && !variant) {
      deps.emit({ t: "failed", jobId, error: appError("not-found"), resumable: true, keptRatio: keptRatio(job) });
      return;
    }
    await continueWith(job, source, variant);
  }

  async function discard(jobId: string): Promise<void> {
    if (active.has(jobId)) await api.cancel(jobId);
    await deps.engine.send({ t: "engine/discard", jobId }).catch(() => undefined);
    await jobs.remove(jobId);
  }

  async function recover(): Promise<void> {
    const all = await jobs.list();
    const live = all.filter((j) => !active.has(j.id));
    for (const j of recoverInterrupted(live, now())) {
      if (all.find((o) => o.id === j.id)?.status !== j.status) await jobs.put(j);
    }
  }

  async function sweep(nowMs: number = now()): Promise<void> {
    const records = (await jobs.list()).map((j) => ({ id: j.id, status: j.status, resumable: j.resumable, updatedAt: j.updatedAt }));
    lifecycle.jobStarted("sweep");
    try {
      const reported = new Promise<string[]>((r) => sweepWaiters.push(r));
      await deps.engine.send({ t: "engine/sweep", records, now: nowMs });
      const evicted = await reported;
      // a failed job whose chunks are gone cannot resume: drop the record too
      for (const id of evicted) {
        const rec = await jobs.get(id);
        if (rec?.status === "failed") await jobs.remove(id);
      }
    } finally {
      lifecycle.jobFinished("sweep");
    }
  }

  const api: DownloadOrchestrator = {
    start: startJob,
    resume: resumeJob,
    resumePicked,
    discard,
    recover,
    sweep,

    async download({ tabId, sourceId, options }) {
      const source = await deps.lookupSource(tabId, sourceId);
      if (!source) {
        const jobId = newId();
        deps.emit({ t: "failed", jobId, error: appError("not-found"), resumable: false, keptRatio: 0 });
        return jobId;
      }
      return startJob(source, options);
    },

    async cancel(jobId) {
      const a = active.get(jobId);
      if (!a) {
        // not running here (failed or finished earlier): drop the record and any kept chunks
        const rec = await jobs.get(jobId);
        if (!rec || rec.status === "done" || rec.status === "cancelled") return;
        await jobs.put(cancelRecord(rec, now()));
        await deps.engine.send({ t: "engine/discard", jobId }).catch(() => undefined);
        deps.emit({ t: "cancelled", jobId });
        return;
      }
      if (a.cancelling) return;
      a.cancelling = true;
      a.ac.abort();
      if (a.busy === "fetch" || a.busy === "engine" || a.busy === "assemble") {
        await deps.engine.send({ t: "engine/cancel", jobId }).catch(() => undefined);
        return; // the engine answers with engine/error{cancelled}, which finalizes
      }
      await finalizeCancel(a);
    },

    onEngineMessage(msg) {
      inbox = inbox.then(() => handleEngine(msg)).catch(() => undefined);
      return inbox;
    },

    async onEngineDisconnect() {
      engineOwner = undefined;
      for (const done of sweepWaiters.splice(0)) done([]);
      for (const a of [...active.values()]) {
        if (!a.busy && !engineQueue.includes(a.id)) continue;
        a.busy = undefined;
        if (a.cancelling) await finalizeCancel(a);
        else await failJob(a, appError("network", "the converter stopped"));
      }
    },

    onDownloadChanged(delta) {
      const id = byDownload.get(delta.id);
      const a = id ? active.get(id) : undefined;
      if (!a || a.finalized) return;
      const state = delta.state?.current;
      if (state === "complete") {
        void complete(a, delta.id).catch(() => undefined);
      } else if (state === "interrupted" || delta.error?.current) {
        void interrupted(a, delta.id, delta.error?.current).catch(() => undefined);
      }
    },
  };
  return api;

  async function interrupted(a: Active, downloadId: number, code: string | undefined): Promise<void> {
    const item = (await downloads.search({ id: downloadId }).catch(() => []))[0];
    if (item?.canResume && a.directResumes < MAX_DIRECT_RESUMES) {
      a.directResumes++;
      try {
        await downloads.resume(downloadId);
        return;
      } catch {
        /* fall through to cleanup */
      }
    }
    // no partial files (spec §7)
    await downloads.removeFile(downloadId).catch(() => undefined);
    await downloads.erase({ id: downloadId }).catch(() => undefined);
    a.downloadId = undefined;
    byDownload.delete(downloadId);
    await failJob(a, downloadError(code));
  }
}
