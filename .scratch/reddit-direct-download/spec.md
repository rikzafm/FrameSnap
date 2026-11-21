Status: ready-for-agent

# Reddit: direct DASH download instead of recorder fallback

## Problem Statement

When a user opens a Reddit page with a video and clicks download, FrameSnap frequently falls back to real-time MediaRecorder capture instead of downloading the DASH segments directly. This makes downloads take as long as the video itself, produces lower-quality WebM output, cannot be resumed, and shows a "capture-recorder" warning. Even when a DASH stream is detected over the network, the recorder card from the player's `blob:` `<video>` element can outrank it and get selected by default in the popup.

## Solution

Ensure Reddit videos are reliably detected as direct DASH sources from both the DOM and the network, and prevent the player's internal `blob:` `<video>` element from creating a competing recorder card:

1. Accept any `v.redd.it` media request (HLS playlists, DASH manifests, and CMAF/DASH MP4 segments) in the Reddit network detector and normalize it to the canonical DASH manifest URL.
2. Scan Reddit player and post elements directly in the DOM detector (both new Shreddit layouts and old Reddit), deriving canonical post/comment IDs and titles, and claiming the player's inner `<video>` element so its DOM facts (`frameRef`, visibility, playback state, duration) attach directly to the DASH source instead of spawning a duplicate recorder card.
3. Broaden capture-duplicate folding in ranking so site-specific network finds can also fold with capture-only `<video>` elements as a safety net when DOM markup changes.

## User Stories

1. As a user browsing a Reddit post with a video, I want FrameSnap to detect the video immediately as a DASH source so that I can download it at full quality without waiting for real-time recording.
2. As a user on modern Reddit where the player streams HLS (`HLSPlaylist.m3u8`) instead of DASH, I want the network sniffer to still recognize the `v.redd.it` media ID and resolve its DASH manifest so that I get a fast, muxed download with audio.
3. As a user opening the popup on a Reddit video post, I want only one entry for the video (the DASH download) and never a duplicate recorder card ranked above it so that clicking Download always uses the fast path.
4. As a user browsing a Reddit feed with multiple video posts (including clips of similar length), I want every video post to appear with its own post title and accurate visibility ranking so that the video I'm looking at is selected first.
5. As a user who just installed the extension or whose service worker restarted, I want videos on the currently open Reddit page to be detected from the DOM even though the initial network requests were missed.
6. As a user on a Reddit comment page with an embedded video reply, I want that comment video to be detected with its own comment ID so that it stays separate from the parent post and downloads as DASH.
7. As a user scrolling a Reddit feed where players lazy-load, I want videos to be detected as soon as their `<shreddit-post>` or player element appears in the DOM so that they are immediately downloadable.
8. As a user on `old.reddit.com`, I want video posts to be detected from the DOM with their canonical post ID and title so that direct downloads and cross-layout resume work consistently.
9. As a user resuming an interrupted Reddit download after refreshing or switching between `www.reddit.com` and `old.reddit.com`, I want the detected source to keep its canonical post ID so that resume matches it automatically.
10. As a user taking a Frame Snap, seeking, or making a GIF from a Reddit video, I want the DASH source to retain the `<video>` element's `frameRef` and playback state so that all in-page actions continue to work.
11. As a user on a Reddit page using the newer `shreddit-video-player` custom element, I want FrameSnap to recognize it alongside `shreddit-player` and `shreddit-player-2` so that frontend rollouts do not trigger recorder fallback.
12. As a user on non-Reddit websites, I want the DOM detector to skip Reddit-specific element checks so there is no unnecessary overhead.

## Implementation Decisions

### Reddit network detection accepts all `v.redd.it` media hits

Modern Reddit players primarily request `HLSPlaylist.m3u8` and `CMAF_*.mp4` rather than `DASHPlaylist.mpd`. The Reddit adapter's network detector will accept any `v.redd.it` media hit (`.m3u8`, `.mpd`, or `.mp4`) rather than filtering strictly for `DASHPlaylist.mpd`, extracting the `v.redd.it` media ID and normalizing it to the canonical bare `DASHPlaylist.mpd` URL. Duplicate hits for the same media ID deduplicate naturally.

### The DOM detector scans Reddit players and posts directly, gated by host

Rather than serializing the full page HTML, the DOM detector will check whether the frame URL matches Reddit and, when it does, extract Reddit video sources directly from the live DOM (including open shadow roots):

- Recognized new-layout player tags: `shreddit-player`, `shreddit-player-2`, and `shreddit-video-player`, checking `src` and `video-url` attributes for a `v.redd.it` media ID.
- Early detection from `shreddit-post` elements whose `content-href` points to `v.redd.it` (before the lazy-loaded player mounts).
- Old-layout player containers (`.reddit-video-player-root`) reading `data-mpd-url` and `data-hls-url`.
- Canonical ID and title derivation from enclosing post/comment containers (`shreddit-post` `id`/`post-title`, `shreddit-comment` `thingid`, old-layout `.thing` `data-fullname` and `.title`), matching the conventions of the HTML parser so resume and registry merging stay consistent across layouts.

### Claiming the player's inner `<video>` eliminates duplicate recorder cards

When a `<video>` element (typically with a `blob:` source) is contained inside a detected Reddit player element (light DOM or open shadow root), the DOM detector will attach that `<video>` element's `frameRef`, DOM facts (`visibleRatio`, bounding rect, `playing`, `currentTime`), `duration`, and fallback `thumbnail` directly onto the Reddit DASH source and skip emitting a standalone `dom:` blob/recorder source for that `<video>`. This guarantees:

- No duplicate recorder card in the popup.
- Accurate visibility/playback ranking in feeds and single posts.
- Frame Snap, seek, and GIF workflows remain linked to the `<video>` element.

### Site-specific helpers live in the Reddit adapter

The Reddit adapter will export pure helpers for recognizing Reddit player/post elements and building canonical Reddit DASH sources (ID derivation, canonical MPD URL construction, and recognized tag/attribute lists) so site-specific rules stay in the adapter module while the DOM detector handles DOM traversal and `<video>` ownership.

### Capture-duplicate folding also covers site-specific network finds

As a defense-in-depth safety net (in case Reddit changes its DOM markup again and only the network sniffer catches the video), capture-duplicate folding in the ranking module will allow site-specific sources (`site !== "generic"`) detected via `"network"` (not only `"adapter"`) to fold with matching capture-only `<video>` entries.

### Existing `redditSourcesFromHtml` parser stays updated in lockstep

The HTML parser will also recognize `shreddit-video-player` (including `video-url`) and `shreddit-post` `content-href` so it remains consistent with live DOM detection and continues to serve as a pure HTML-fixture seam.

### No changes to the planner, download routes, or engine

Once a DASH source is in the registry and not outranked by a `blob:` recorder card, the existing planner selects `route: "segments"` and the existing download pipeline muxes video and audio via DASH.

## Testing Decisions

Good tests exercise external behavior at existing module boundaries: given network hits, HTML fixtures, a jsdom document, or a list of sources to rank, verify the resulting `VideoSource` list (ids, variants, DOM facts, titles, and absence of recorder duplicates) without asserting internal helper call counts or selector implementation details.

### Modules tested

- **Reddit adapter** (`redditAdapter.detect`, `redditSourcesFromHtml`):
  - Network detection catches `HLSPlaylist.m3u8` and `CMAF_*.mp4` hits on `v.redd.it` and normalizes them to the canonical `DASHPlaylist.mpd` URL, deduplicating multiple hits for the same media ID.
  - Recognizes `shreddit-video-player` (with `src` or `video-url`) and `shreddit-post` `content-href` before a player element is present.
  - Preserves canonical post/comment IDs and titles, and merges cleanly with network-sniffed finds.

- **DOM detector** (`createDomDetector(...).scan()`):
  - On a Reddit URL, a `<shreddit-post>` containing `<shreddit-player-2>` with an inner shadow-DOM `<video src="blob:...">` produces a single Reddit DASH source (with canonical post ID, title, `frameRef`, `dom` facts, and `duration`) and **no** `dom:` recorder source.
  - A `<shreddit-post>` with `content-href` and no player yet produces a Reddit DASH source.
  - Comment videos (`<shreddit-comment>`) and old Reddit (`.reddit-video-player-root`) produce canonical Reddit DASH sources and suppress inner `blob:` recorder duplicates.
  - Non-Reddit URLs are unaffected.

- **Ranking / capture-duplicate folding** (`rankSources` / `foldCaptureDuplicates`):
  - A site-specific network-detected DASH source folds with a duration-matching capture-only `<video>` source instead of being outranked by the recorder card.

### Prior art

- `tests/unit/reddit-adapter.test.ts` and `tests/fixtures/reddit-pages.ts`
- `tests/unit/dom-detect.test.ts`
- `tests/unit/rank-fold.test.ts`

## Out of Scope

- **Reddit videos embedded on third-party sites** — the Reddit adapter matches `reddit.com` hostnames only.
- **Live Reddit broadcasts** — not served via `v.redd.it` DASH.
- **Changes to the download planner, DASH segment fetcher, or ffmpeg muxing** — already functional for `v.redd.it` DASH manifests.

## Further Notes

- `MutationObserver` on `childList` does not fire when a custom element attaches a shadow root after insertion. Reading attributes directly from light-DOM `<shreddit-post>` / `<shreddit-player*>` elements ensures DASH detection works immediately without waiting on shadow-root attachment; existing media events (`loadedmetadata`, `play`) and mutations attach `<video>` facts once the inner `<video>` mounts.
- If a user triggers the in-page picker download before ever opening the popup, `resolve` has not yet expanded the manifest; that is a general picker behavior across HLS/DASH adapters and can be tracked separately if needed.
