# 10 — Resume wiring (startup recovery, re-detect, decide, continue, cleanup)

Status: resolved
Blocked by: 06, 07, 09
Spec: ../spec.md §6.6

The algorithm is built and tested in core (`decideResume`, `matchSource`, `runFetchPhase`). This ticket connects it to the extension.

## What
- SW start: `recoverInterrupted(allJobs)` → persist. Then run cleanup (`selectEvictions` with `storeCap(quota)`), and schedule a daily `chrome.alarms` alarm that repeats it.
- `media/list` replies include `resumableOn(jobs, canonicalPageUrl(tab.url))` for the banner.
- `job/resume {jobId, tabId}`:
  1. wait ≤ 5 s for the registry to settle on the tab;
  2. `matchSource(job.source, sources, audioOnly)`;
  3. re-plan with the stored options, probe/parse, `buildTracks`, `trackValidators`;
  4. `decideResume`:
     - `continue`: write `keep` into the record, `start`, then the 09 pipeline from the fetch phase (or straight to the engine when `fetchComplete`);
     - `restart`: `deleteJob` chunks, new tracks, notice copy `changed`;
     - `pick`: send `resume-needs-pick`; the popup closes and the picker opens in resume mode (07). `picker/picked` → `acceptsPicked`, then continue from step 3.
- Resume from History when the tab is gone: after a prompt, open `job.source.pageUrl` in a new tab, then do the above.
- `job/discard`: `deleteJob` chunks + record.

## Done when
- E2E, using a fixture server that can rotate signed URLs and kill connections:
  - progressive, HLS and DASH pair each fail at 50 % → page reload → Resume → server log shows only the missing ranges/segments → output hash equals an uninterrupted run;
  - the same after a browser relaunch (new persistent context);
  - a changed ETag → restart with the notice;
  - two same-length videos → picker → resume.
- Discard and 7-day expiry leave no OPFS files.

## Answer

Built test-first at the orchestrator seam (`tests/unit/resume-wiring.test.ts`, 11 tests, real engine host + fake CDN with rotating signed URLs and scripted failures; plus one `media-service` test).

- `src/background/download.ts`: `resume(jobId, tabId)`, `resumePicked`, `discard`, `recover`, `sweep`.
  - `resume`: if the tab is gone or shows another page it opens `job.source.pageUrl` (`openTab`, 3x the wait); polls the registry (`listSources`, 250 ms steps, default `settleMs` 5 s) until `matchSource` finds the video; otherwise emits `resume-needs-pick`. Then re-plans with the stored options (quality pinned to the matched variant id), `prepareTracks` (probe/parse, `buildTracks`, `trackValidators`, shared with the first-run path), `decideResume`.
  - `continue`: committed keys kept in the record, `start`, `engine/fetch` with the fresh URLs (the host reconciles against the store, so only missing chunks are requested); if the fetch was already complete it goes straight to the engine phase. `restart`: `notice {code:"changed"}` event, `engine/fetch` with `fresh: true` (the host wipes the job's chunks first, so there is no ordering race with a separate discard). `pick`: `resume-needs-pick` (the popup already posts `picker/start`); `picker/picked` -> `acceptsPicked` (router) -> `resumePicked` continues from re-planning.
  - `discard`: cancels if running, `engine/discard`, removes the record. `recover`: `recoverInterrupted` on records not run by this worker. `sweep`: sends `engine/sweep`; the host runs `selectEvictions(storeCap(quota))` and deletes the chunks; the worker drops the records of evicted failed jobs.
- `src/offscreen/host.ts`, `src/core/engine-messages.ts`: new `engine/sweep` / `engine/swept`, `fresh` flag on `engine/fetch`. `src/core/jobs/cleanup.ts`: `selectEvictions` takes `SweepRecord` (the fields it reads).
- `src/core/messages.ts`: `media/updated.resumable` (jobs for the page via `resumableOn(jobs, canonicalPageUrl(tab.url))`, added by `media-service`), `JobEvent` `notice`. Popup: uses `resumable` from `media/updated`, shows the `changed` copy as a toast.
- `src/background/index.ts`: routes `job/resume` and `job/discard`, `resumePicked` wired, startup `recover()` then `sweep()`, daily `chrome.alarms` sweep. `src/platform/chrome.ts`: `tabs.create`.

Not done / open
- Real-Chrome e2e (Playwright, browser relaunch with a persistent context) is not run; the rows are covered in `npm test` against the fake backend. The relaunch case uses the same path (records in storage, chunks in the store, `recover` on start) but is not exercised in a browser.
- The History page's confirmation prompt is ticket 17's UI; the worker opens the tab when `job/resume` arrives with a tab that is gone or on another page.
