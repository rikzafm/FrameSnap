# 09 — Download orchestrator (service worker)

Status: ready-for-agent
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
