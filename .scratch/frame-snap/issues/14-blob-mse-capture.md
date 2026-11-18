# 14 — Generic blob: sources (MSE hook + MediaRecorder fallback)

Status: resolved
Blocked by: 05, 09
Spec: ../spec.md §6.2 (capture route), decision Q8

## What
- `src/main-world/mse-hook.ts`: on granted sites, at `document_start`, record the init + media segments per SourceBuffer (memory-capped, opt-in per site). Exposed as `mse-capture` variants.
- MediaRecorder fallback on `video.captureStream()` → `recorder` variant, with real-time progress. Needs the video to be playing.
- Both use the `capture` route (not resumable). The UI says why.

## Done when
- Fixture MSE player: capture → an MP4 that plays for the buffered range.
- The fallback records 5 s from a blob: video.

## Answer

Built test-first at these seams: the MSE hook (`installMseHook` over a fixture MediaSource/SourceBuffer), the main-world/isolated protocol, `recordVideo`, the content capture runner, and the orchestrator's capture route against the real harness.

- `src/main-world/mse-hook.ts`: wraps `addSourceBuffer`/`appendBuffer`/`createObjectURL`, copies every segment per SourceBuffer, memory-capped (256 MB default; drops the oldest media segments, keeps init segments, flags `truncated`). `export` returns init + media segments in append order (fMP4 or WebM). With separate audio and video buffers it exports the video track and reports `hasAudio: false`.
- `src/main-world/mse-protocol.ts` + `mse-main.ts`: nonce-checked postMessage channel; the Blob is structured-cloned to the content script. The handshake is started by `src/content/index.ts`.
- Opt-in per site: `src/platform/mse-scripts.ts` registers the MAIN-world hook at `document_start` only for origins granted at runtime (not the built-in site list), kept in sync with `permissions.onAdded/onRemoved` in `src/background/index.ts`.
- `src/content/recorder.ts`: MediaRecorder on `video.captureStream()`, real-time progress, stops early on `ended`, needs the video playing (otherwise `unsupported`), cancellable. Output WebM.
- `src/content/capture.ts`: `blobVariants` (an `mse-capture` variant when the hook saw the stream, plus a `recorder` variant) fed through the new `blobVariants` option and `refresh()` of the DOM detector; `createCaptureRunner` handles `capture/start|cancel|revoke` and returns a `blob:` URL to the worker.
- `src/background/download.ts`: `plan.route === "capture"` sends `capture/start` to the frame (`frameRef.frameId`), relays progress, saves the returned `blob:` URL through `chrome.downloads` under the real extension (`.webm`/`.mp4`), asks the page to revoke afterwards, and drops late results after a cancel. `start()` takes `{ tabId }`; the picker download passes it. `capture/*` messages added to `src/core/messages.ts` with guards.
- "The UI says why": new plan warnings `capture-recorder` and `capture-mse` (real time and must be playing; only what is buffered; neither can be resumed), shown by the existing popup warning row.
- Tests: `mse-hook`, `mse-protocol`, `recorder`, `capture-runner`, `mse-scripts`, `download-capture`, plus additions to `popup-model`.

Not covered or open
- Nothing was run in a loaded Chrome. "Plays for the buffered range" is asserted as byte equality (init + segments in order); playback in a real player is unverified.
- The capture route ignores the chosen format and trim for MSE (the file is what the page buffered); the recorder honours a trim only as the recording length. No transcoding of WebM recordings to MP4.
- A mid-stream quality switch appends a second init segment into the same file; players may not follow it.
- Sites with separate audio and video SourceBuffers: the MSE file is video only; the recorder variant carries audio.
- The hook is not injected into tabs already open when access is granted until they reload.
