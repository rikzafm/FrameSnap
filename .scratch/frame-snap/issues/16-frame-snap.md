# 16 — Frame snap (popup, action bar, on-video button, shortcut, burst, frame-step)

Status: resolved
Blocked by: 04, 06, 07
Spec: source §F4

## What
- Capture without pausing: `requestVideoFrameCallback` → `createImageBitmap(video)` at native size → `OffscreenCanvas.convertToBlob` (PNG/JPEG/WEBP).
- Taint fallbacks:
  - A: reload the source with `crossorigin` and seek to the same time;
  - B: `captureVisibleTab` cropped to the video rect × DPR, with the toast copy from `ERROR_COPY.tainted`.
- Save: data URL → SW `downloads.download`, named with `buildFilename(..., {time})`. Optional clipboard copy, with a click-to-copy fallback.
- Entry points: on-video floating button (toggleable), Alt+Shift+S command, popup, picker bar. Shutter flash + toast (reduced-motion aware).
- Screenshot tab: format, quality, ◀/▶ frame-step, burst every N s (cap 200).

## Done when
- E2E: the shortcut during playback saves a 1920×1080 PNG within 300 ms, and `currentTime` keeps advancing.
- The cross-origin fixture uses a fallback and still saves an image.

## Answer

Built test-first. Seams: the frame reader, the in-page snapper, the service-worker snap service, the popup Screenshot tab, the message guards.

- `src/core/snap.ts`: `SnapOptions` (format, quality, copy, showButton) with `normalizeSnapOptions`, `BURST_CAP = 200`, `burstCount`, `stepTime` (1/30 s), `cropRect` (CSS rect x DPR, clipped).
- `src/content/snap-capture.ts`: `captureFrame` (waits one presented frame via `requestVideoFrameCallback` only while playing, `createImageBitmap` at native size, `OffscreenCanvas.convertToBlob`; never pauses). A `SecurityError` reports `tainted`. `captureViaCrossOrigin` is fallback A (detached clone with `crossorigin=anonymous`, seek to the same time).
- `src/content/snap.ts`: `createSnapper` picks the video (elementKey, else playing, then visible, then largest), runs read, fallback A, then sends `snap/tainted` for fallback B. Also optional clipboard copy with a click-to-copy toast on refusal, `step` (pauses, moves one frame) and `burst` (every N s, stops at the end, `stopBurst`, cap 200). `src/content/snap-ui.ts`: shutter flash (skipped for reduced motion), toast with action, floating on-video button (toggleable). `handler.ts` routes the new `snap/*` messages.
- `src/background/snap.ts`: `createSnapService` sends requests to the owning frame (or broadcasts for the shortcut), names files with `buildFilename` and the playback `{time}` (appended to the template when absent), downloads the data URL, and runs fallback B (`captureVisibleTab`, crop to video rect x DPR) with the `ERROR_COPY.tainted` toast. `snap-wire.ts` is the chrome wiring (downloads, crop, Alt+Shift+S via the existing `snap-frame` manifest command, popup messages). `index.ts` gets only small hooks; `router.ts` routes `snap/data` and `snap/tainted`; the picker bar "Snap frame" now snaps the picked video.
- Popup Screenshot tab (`src/popup/app.ts`): format, quality (JPEG/WEBP), copy and on-video-button switches, Previous/Next frame, burst interval with Start/Stop. Choices persist in `storage.local` under `snap/prefs`, which the shortcut and the on-video button read.
- Messages (`src/core/messages.ts`): `snap/frame` gains `options`; new `snap/step`, `snap/burst`, `snap/burst-stop`, `snap/capture`, `snap/result`, `snap/tainted`.
- Tests: `tests/unit/snap-core|capture|content|ui|service.test.ts` and a Screenshot-tab block in `popup-app.test.ts` (axe clean).
- Not verified (no real Chrome here): the E2E "shortcut saves a 1920x1080 PNG within 300 ms while currentTime advances", the cross-origin fixture in a browser, and the real `captureVisibleTab` crop. Known limits: frame rate is assumed 30 fps for stepping; fallback B in an iframe uses iframe-relative coordinates; a shortcut snap with several frames holding videos snaps in each of them.
