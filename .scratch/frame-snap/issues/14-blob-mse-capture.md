# 14 — Generic blob: sources (MSE hook + MediaRecorder fallback)

Status: ready-for-agent
Blocked by: 05, 09
Spec: ../spec.md §6.2 (capture route), decision Q8

## What
- `src/main-world/mse-hook.ts`: on granted sites, at `document_start`, record the init + media segments per SourceBuffer (memory-capped, opt-in per site). Exposed as `mse-capture` variants.
- MediaRecorder fallback on `video.captureStream()` → `recorder` variant, with real-time progress. Needs the video to be playing.
- Both use the `capture` route (not resumable). The UI says why.

## Done when
- Fixture MSE player: capture → an MP4 that plays for the buffered range.
- The fallback records 5 s from a blob: video.
