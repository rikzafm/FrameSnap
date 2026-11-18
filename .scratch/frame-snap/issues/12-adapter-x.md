# 12 — X (Twitter) adapter + main-world network tap

Status: ready-for-agent
Blocked by: 05
Spec: ../spec.md §4; source §F6

## What
- `src/main-world/net-tap.ts`: wrap `fetch`/XHR and pass GraphQL JSON (TweetDetail, timelines) to the content script over nonce-checked `postMessage`. Registered on x.com/twitter.com at `document_start`.
- `video_info.variants`: each mp4 bitrate becomes a variant (`acceptsRanges` from the sniffer), and the m3u8 is the HLS fallback. Matched to the DOM `<video>` via the tweet `article`.
- Canonical id `x:<tweet id>:<media key>`.

## Done when
- Fixture tests: tweet detail with 3 bitrates, timeline with 2 videos, GIF-type tweet, HLS-only tweet.
- Manual checklist `docs/testing/manual-x.md` passes.
