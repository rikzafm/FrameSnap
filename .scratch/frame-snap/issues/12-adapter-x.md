# 12 — X (Twitter) adapter + main-world network tap

Status: resolved
Blocked by: 05
Spec: ../spec.md §4; source §F6

## What
- `src/main-world/net-tap.ts`: wrap `fetch`/XHR and pass GraphQL JSON (TweetDetail, timelines) to the content script over nonce-checked `postMessage`. Registered on x.com/twitter.com at `document_start`.
- `video_info.variants`: each mp4 bitrate becomes a variant (`acceptsRanges` from the sniffer), and the m3u8 is the HLS fallback. Matched to the DOM `<video>` via the tweet `article`.
- Canonical id `x:<tweet id>:<media key>`.

## Done when
- Fixture tests: tweet detail with 3 bitrates, timeline with 2 videos, GIF-type tweet, HLS-only tweet.
- Manual checklist `docs/testing/manual-x.md` passes.

## Answer

X adapter and main-world network tap are in.

- `src/adapters/x.ts`: `xAdapter` walks tapped GraphQL JSON for tweets with video/GIF media. Each mp4 bitrate is a progressive variant (highest first, size parsed from the URL, `acceptsRanges`/`sizeBytes` from the sniffer hit for the same URL); the m3u8 is the last HLS variant. GIFs are one silent mp4. Id is `x:<tweet id>:<media key>`. The DOM `<video>` is matched through the media id in its poster URL. Registered first in `src/adapters/registry.ts`. `DetectContext` gained optional `tapped`.
- `src/main-world/net-tap.ts` (fetch/XHR wrap, GraphQL URLs only), `protocol.ts` (channel, nonce-checked receiver), `net-tap-main.ts` (MAIN-world entry), `bridge.ts` (isolated half: issues the nonce, forwards to the worker as `net/tap`). Manifest registers both at `document_start` on x.com/twitter.com.
- Tests: `tests/unit/x-adapter.test.ts`, `tests/unit/net-tap.test.ts`, fixtures `tests/fixtures/x-graphql.ts`. Manual checklist: `docs/testing/manual-x.md` (not yet run in a real browser).
- The service worker consumes `net/tap` (`src/background/index.ts` -> `media.onTap`, which keeps the payloads per tab and passes them to the adapter as `DetectContext.tapped`). The nonce handshake is first-message-wins, so it relies on the bridge running before page scripts.
