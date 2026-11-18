# 11 — Reddit adapter

Status: resolved
Blocked by: 05
Spec: ../spec.md §6.4 (DASH whole files); source §F6

## What
- Layouts: new (`shreddit-player`, shadow root), old (`.reddit-video-player-root`, `data-mpd-url` / `data-hls-url`), feeds and comments.
- `DASHPlaylist.mpd` → `parseMpd`: video representations become variants (`hasAudio: false`) and audio representations become `audioTracks`. Both handle `CMAF_*` and legacy `DASH_*` names.
- Canonical id `reddit:<t3 post id>`, so resume matches by id after a refresh. Title from the post.
- Selectors and URL patterns in one block at the top of the file.

## Done when
- Fixture tests: new post, old post, feed with 2 videos, comment video, video without audio.
- Manual checklist `docs/testing/manual-reddit.md`: the downloaded MP4 has audio, and resume after a refresh works.

## Answer

Built test-first at two seams: `redditSourcesFromHtml(html, pageUrl, pageTitle)` (layout parsing, fixtures) and `redditAdapter.detect` / `resolve` (network log, MPD expansion).

- `src/adapters/reddit.ts`: selectors and URL patterns in one block at the top. New layout (`shreddit-post` / `shreddit-player`, `shreddit-comment`), old layout (`.thing` + `.reddit-video-player-root` with `data-mpd-url` / `data-hls-url`), feeds and comments. Ids: `reddit:<t3 id>` (post), `reddit:c-<t1 id>` (comment video), falling back to the post id in the page URL, then `reddit:v-<media id>`. Titles come from the post (`post-title` / `a.title`).
- `resolve` expands `DASHPlaylist.mpd` via `parseMpd`: video representations become variants (`hasAudio: false`), audio representations become `audioTracks`. Classification is by AdaptationSet, so `CMAF_*` and `DASH_*` names both work; a silent clip has no audio tracks. A failed fetch returns the source unchanged.
- Registered in `src/adapters/registry.ts` ahead of the generic adapter.
- Tests: `tests/unit/reddit-adapter.test.ts`, fixtures `tests/fixtures/reddit-pages.ts` (new post, old post, feed with 2 videos, comment video, no-audio video, CMAF and legacy MPDs). Manual checklist: `docs/testing/manual-reddit.md`.
- Integration note: `DetectContext` carries no DOM attributes, so `detect` only sees sniffed `DASHPlaylist.mpd` hits and `v.redd.it` `<video>` sources. Full DOM-structure detection (feeds, titles, comments) needs the content script to serialize the page, including open shadow roots, and call `redditSourcesFromHtml`; that wiring is outside this ticket.
