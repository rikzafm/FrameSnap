# 10 — Resume wiring (startup recovery, re-detect, decide, continue, cleanup)

Status: ready-for-agent
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
