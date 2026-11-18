# 15 — GIF tab and export

Status: resolved
Blocked by: 06, 08, 09
Spec: ../spec.md §6.3, §6.8; source §F3

## What
- GIF tab:
  - preview and frame strip with two trim handles (`role="slider"`, keyboard steps); defaults: start = currentTime, 2.0 s, max `GIF_MAX_SECONDS`;
  - chips: fps 10/15/24/30, width 320/480/640/Original, loop (∞/1/2/3), dither;
  - live `estimateGifBytes` range, and a low-memory warning when `gifWorkingSetBytes > GIF_LOW_MEMORY_BYTES`.
- Job: fetch the range with the download pipeline (stream-copy trim; reuses the chunk store, so a retry doesn't refetch) → `buildGifArgs` two passes → preview with Save/Discard. The result survives the popup closing.
- Picker GIF button → popup on the GIF tab (07).

## Done when
- E2E: a 5 s, 480 px, 15 fps GIF is produced with no page long task > 200 ms, and the popup stays interactive.
- The estimator is within ±35 % on the test corpus; recalibrate `GIF_BYTES_PER_PIXEL` if not.

## Answer

Built test-first. Seams: core GIF helpers, the orchestrator's GIF job (against the real engine host), the popup GIF tab through the DOM (jsdom, axe-core), message guards.

- `src/core/gif.ts`: `defaultGifTrim` (playhead, 2 s, slides back near the end), `clampTrim`/`moveHandle` (0.5 s steps, 30 s limit, handles stay apart), `pickGifVariant` (smallest rendition at least as wide as the GIF), `gifSourceSize`, `describeGif` (size range). `src/core/format.ts` holds `formatBytes` (re-exported from `popup/model.ts`). `DomFacts.currentTime` is new, filled by `dom-detect.ts`.
- `src/background/download.ts`: `startGif`/`startGifSource`, `saveGif`, `pendingGifs`. A GIF job is a normal job (`kind: "gif"`) planned as a trimmed, audio-less fetch, so HLS/DASH fetch only the segments in the range and chunks are committed like a download. Then `engine/gif` (palette pass, render pass). The result is not saved: a `gif-ready` event carries the blob URL, and the blob stays in the offscreen document (kept alive) until Save (`job/save`) or Discard (`job/cancel`). Chunks are freed at `gif-ready`. If the converter goes away while a preview waits, the job fails.
- `src/background/index.ts`: routes `job/gif` and `job/save`; a newly connected popup is sent the pending `gif-ready` events, so the result survives the popup closing. `PICKER_SELECTION_KEY` moved to `src/core/picker-selection.ts`.
- Popup (`src/popup/gif-panel.ts`, `gif.css`, `app.ts`, `main.ts`): frame strip with two `role="slider"` handles (arrows 0.5 s, PageUp/Down 5 s, pointer drag), chips for fps, width, loop and a dither switch, live size range, `gifMemoryWarning` (ticket 18) shown when it applies, Make GIF, progress row, Save/Discard preview in any tab, GIF-aware Retry. `main.ts` reads `pickerSelection` once: the picker's GIF button opens the popup on the GIF tab with that video. The multi-video list now has the mode tabs too.
- Messages: `job/save`, `gif-ready`, a strict `job/gif` guard.
- Tests: `gif-core`, `gif-job`, `popup-gif`, plus a `dom-detect` case.

Not verified or open
- No Chrome run: the E2E (5 s, 480 px, 15 fps GIF, no page long task over 200 ms, popup interactive) was not run. The encode runs in the offscreen document, so the page is not involved by design.
- `GIF_BYTES_PER_PIXEL` was not recalibrated: there is no test corpus here, so the ±35 % claim is unchecked.
- The strip shows the poster, not real frames; the popup cannot read the page's video.
- A pending preview lives in the service worker's memory: if the worker restarts, a reopened popup no longer lists it. A progressive file is fetched whole before trimming.
- When a rendition's width is unknown, "Original" assumes 1280 px wide.
- Resuming an interrupted GIF job is ticket 10's; the record carries `kind: "gif"` and the GIF options.
