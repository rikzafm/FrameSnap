# 11 — Reddit adapter

Status: ready-for-agent
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
