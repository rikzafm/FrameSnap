# 19 — YouTube adapter (personal build only)

Status: resolved
Blocked by: 05, 09
Spec: ../spec.md §1 (Q3), §8; source §8

## What
- Main-world read of `ytInitialPlayerResponse.streamingData` (adaptiveFormats + formats). Video formats become variants (`hasAudio: false`) and audio formats become `audioTracks`, muxed by the 09 pipeline. Canonical id `youtube:<videoId>`.
- Compiled only when `__YOUTUBE__` is true; the YouTube/googlevideo host permissions are only in the personal manifest.
- Script check: the store `dist/` contains no `youtube` / `googlevideo` strings, and the footer omits YouTube.

## Done when
- The personal build downloads 1080p with audio, and the store-build check passes.

## Answer

YouTube adapter is in, personal build only. Built test-first at the adapter `detect` seam (fixture player response), the manifest, and the build-check script.

- `src/adapters/youtube.ts`: reads tapped `{ kind: "youtube-player", response }` payloads (`videoDetails` + `streamingData`). Muxed `formats` and video-only `adaptiveFormats` become progressive variants (`hasAudio` true / false, id `itag:<n>`); audio-only adaptive formats become `audioTracks` (language from `audioTrack.id`). Formats with only a `signatureCipher` (no `url`), unplayable and live responses are skipped. Canonical id `youtube:<videoId>`; the newest payload per video wins.
- `src/main-world/youtube-main.ts` + `youtube-reader.ts`: MAIN-world reader (live `#movie_player.getPlayerResponse()`, falling back to `ytInitialPlayerResponse`). It posts through the existing nonce-checked tap protocol on load and `yt-navigate-finish`; the shared `bridge.ts` forwards it as `net/tap`, so the existing `media.onTap` path feeds the adapter.
- Gating: `registry.ts` includes the adapter only under `__YOUTUBE__`; `manifest.ts` adds the YouTube content scripts and the YouTube/googlevideo hosts only when `youtube` is true. `src/ui/sites.ts` (`supportedSiteNames()`) is the footer's site list and omits YouTube in the store build. No footer exists yet, so ticket 17 should render it.
- Check: `npm run check:store` (`scripts/check-store-build.ts`) fails if `dist/` has any `youtube`/`googlevideo` string or file name. Verified: store `dist/` passes; `dist-personal/` contains the adapter and manifest entries.
- Tests: `tests/unit/youtube-adapter.test.ts`, `youtube-support.test.ts`.
- Not verified: a real 1080p+audio download from youtube.com in a loaded personal build (needs a manual run). Formats that only offer `signatureCipher` are not deciphered, so such videos yield no sources. googlevideo throttles large single requests; the chunked path from ticket 09 is assumed to cope.
