# 02: Recognize `shreddit-video-player` / `content-href` & export Reddit DOM helpers

**What to build:** Extend the Reddit adapter to handle Reddit's newer player component (`shreddit-video-player`, checking both `src` and `video-url` attributes) and early post-level detection (`shreddit-post` with a `content-href` pointing to `v.redd.it` when no player element has mounted yet). Keep the HTML layout parser in lockstep with these additions, and export pure helper functions from the Reddit adapter for recognizing Reddit player/post elements, extracting `v.redd.it` media IDs, and constructing canonical Reddit DASH sources (with post/comment ID and title derivation) so live DOM detection can reuse them without duplicating site-specific rules.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] The Reddit adapter recognizes `shreddit-video-player` alongside `shreddit-player` and `shreddit-player-2`, extracting the `v.redd.it` media ID from either `src` or `video-url`.
- [x] A `shreddit-post` with `content-href` pointing to `v.redd.it` produces a canonical Reddit DASH source even when no player element is present yet, and does not produce a duplicate when a player element for the same media ID is also present.
- [x] Pure helpers for Reddit element/media-ID extraction and canonical source creation (post ID `reddit:<t3>`, comment ID `reddit:c-<t1>`, URL/media-ID fallback, and canonical `DASHPlaylist.mpd` URL) are exported from the Reddit adapter.
- [x] Adapter fixture tests cover `shreddit-video-player` (both `src` and `video-url`), `shreddit-post` `content-href` early detection, and merging with network-sniffed finds.
