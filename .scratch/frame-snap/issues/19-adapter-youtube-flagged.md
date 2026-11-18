# 19 — YouTube adapter (personal build only)

Status: ready-for-agent
Blocked by: 05, 09
Spec: ../spec.md §1 (Q3), §8; source §8

## What
- Main-world read of `ytInitialPlayerResponse.streamingData` (adaptiveFormats + formats). Video formats become variants (`hasAudio: false`) and audio formats become `audioTracks`, muxed by the 09 pipeline. Canonical id `youtube:<videoId>`.
- Compiled only when `__YOUTUBE__` is true; the YouTube/googlevideo host permissions are only in the personal manifest.
- Script check: the store `dist/` contains no `youtube` / `googlevideo` strings, and the footer omits YouTube.

## Done when
- The personal build downloads 1080p with audio, and the store-build check passes.
