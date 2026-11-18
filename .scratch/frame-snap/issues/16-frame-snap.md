# 16 — Frame snap (popup, action bar, on-video button, shortcut, burst, frame-step)

Status: ready-for-agent
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
