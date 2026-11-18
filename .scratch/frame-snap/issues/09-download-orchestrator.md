# 09 — Download orchestrator (service worker)

Status: resolved
Blocked by: 05, 06, 08
Spec: ../spec.md §6.2, §6.5, §6.6; source §F2, §7

## What
`src/background/download.ts`, for one `job/download` message:
1. `planDownload(source, options)` (surface `drm`/`too-large` before starting).
2. **direct**: `chrome.downloads.download`. On interruption, try `downloads.resume` if `canResume`; otherwise `removeFile` + `erase` (no partial files, §7).
3. **chunked/segments**:
   - probe progressive inputs (HEAD, or `Range: bytes=0-0`) → `probeFromHeaders`; fetch and parse HLS/DASH manifests;
   - `buildTracks` → `trackValidators` → `newJob` + `withTracks` → persist;
   - set DNR session header rules for `source.headers` (Q7).
4. Send the tracks to offscreen and run the fetch phase, persisting commits (batched) and pushing `job/event` progress.
5. Run the engine with `buildDownloadArgs(plan, inputs, out, seeks)`, unless `needsEngine` is false (then assemble the chunks).
6. Save the `blob:` URL via `chrome.downloads` (uniquify, file name from `buildFilename`) → `finish` → delete the chunks → write a history entry.
7. Any error → `fail(job, toAppError(err))`, keeping the chunks if resumable. Cancel → `cancel` + delete the chunks.
- FIFO queue: 1 engine job at a time; fetches may overlap.

## Done when
- E2E on fixtures, one per §6.2 table row (direct, chunked, MKV remux, WEBM transcode, Reddit-style DASH pair, HLS TS + trim, MP3).
- Cancel at 50 % leaves nothing in Downloads or OPFS.

## Answer

The orchestrator is built test-first at one seam: `createDownloadOrchestrator(deps)` driven by `job/download`-style calls, wired to the real offscreen engine host in one process (`tests/helpers/orchestrator-harness.ts`: fake CDN, a concatenating stand-in for ffmpeg, in-memory job storage, recording fakes for `chrome.downloads` and DNR). Tests: `tests/unit/download.test.ts` (19), `engine-link.test.ts`, plus additions to `media-service`, `engine-host` and `engine-messages` tests.

- `src/background/download.ts`:
  - `planDownload`, then `drm` / `too-large` are reported as a `failed` event before any record is written.
  - Direct: `chrome.downloads.download` (uniquify, name from `buildFilename` with `options.filenameTemplate`). On interruption it calls `downloads.resume` if `canResume` (3 tries), otherwise `removeFile` + `erase` and fails (not resumable, no partial file).
  - Chunked and segments: Range `bytes=0-0` probe (HEAD fallback) into `probeFromHeaders`, HLS/DASH manifests fetched and parsed, `buildTracks`, `trackValidators`, `newJob` + `withTracks`, persisted, then `engine/fetch`. Commits go through `JobStore.commitChunks` (batched); the SW never writes a stale copy of the record (read-modify-write).
  - Plan input containers are replaced with the manifest's container before the engine runs (a DASH audio input otherwise said `unknown`).
  - Engine phase: FIFO, one engine job at a time (fetches overlap). `needsEngine: false` sends the new `engine/assemble` command (join the chunks without ffmpeg).
  - Save: `blob:` URL through `chrome.downloads`, completion via `onDownloadChanged`, then `finish`, `engine/discard` (chunks), `engine/revoke`, history entry.
  - Errors: `fail(job, toAppError(err))`; chunks are kept if resumable and discarded otherwise. Cancel: `engine/cancel`, wait for the engine to stop, `engine/discard`, cancel/remove/erase any Chrome download, record `cancelled`. An engine port disconnect fails the running jobs as resumable.
  - Q7: one DNR session rule per job (`modifyHeaders`, request domains of the inputs and every chunk URL), removed on every exit path.
- `src/background/engine-link.ts`: SW end of the `engine` port; `send` creates the offscreen document and waits for its connection. `src/background/history.ts`: `history` key in `storage.local`, newest first, capped at 200 (ticket 17 reads it).
- `src/background/index.ts`: engine port listener (`jobStarted`/`jobFinished` through the orchestrator), `job/download` and `job/cancel` from the popup port, job events broadcast to open popup ports, picker `Download` starts a job with the default settings, `downloads.onChanged`.
- 12 follow-through: `media-service` gained `onTap` (tapped payloads kept per tab, up to 50, passed as `DetectContext.tapped`, cleared on navigation) and `onDomReport` (pushed `dom/report` is now ingested, and `frameRef.frameId` comes from `sender.frameId`).
- `src/core/engine-messages.ts` + `src/offscreen/host.ts`: new `engine/assemble`. `src/platform/chrome.ts`: `downloads.resume/cancel/removeFile/erase`.

Not covered or open
- The e2e rows run against a concatenating fake backend in `npm test`; the real ffmpeg command lines for each row are already covered by `npm run test:engine` (ticket 08). Nothing was run in a loaded Chrome.
- Resume after a refresh (ticket 10) still needs: re-matching, a fresh `buildTracks`, and an entry that starts the fetch phase with kept chunks. `startJob` and `handleEngine` are the pieces to reuse.
- `job/resume`, `job/discard`, `job/gif` and `snap/frame` are not routed. The pull-style `dom/scan` response has no sender frame, so its sources keep `frameId` from the content script (0).
- The X tweet's DOM `<video>` (blob:) is not matched to the tapped source (the DOM detector emits `VideoSource`s, not `DomVideo`s), so it can show as a second entry.
- Progress is not throttled; the popup receives every fetch commit.
