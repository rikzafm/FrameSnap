# 03: Proactive Reddit DOM detection & inner `<video>` ownership

**What to build:** Wire proactive Reddit DOM detection into the content-script DOM detector, gated to Reddit hostnames so non-Reddit pages pay no overhead. When scanning a Reddit page (including open shadow roots), detect new-layout players (`shreddit-player`, `shreddit-player-2`, `shreddit-video-player`), early `shreddit-post` `content-href` video posts, `shreddit-comment` video replies, and old-layout `.reddit-video-player-root` players using the helpers exported by the Reddit adapter. Derive canonical post/comment IDs and post titles from enclosing containers so feeds display real post titles and cross-layout resume continues to match. When a `<video>` element (such as a `blob:` MSE stream) lives inside a detected Reddit player, attach its `frameRef`, DOM visibility/playback facts, duration, and fallback thumbnail directly onto the Reddit DASH source and suppress emitting a separate generic `dom:` recorder source for that `<video>`.

**Blocked by:** 02 (Recognize `shreddit-video-player` / `content-href` & export Reddit DOM helpers)

**Status:** done

- [x] On a Reddit page, a `<shreddit-post>` containing `<shreddit-player>`, `<shreddit-player-2>`, or `<shreddit-video-player>` with an inner shadow-DOM `<video src="blob:...">` produces a single Reddit DASH source (`site: "reddit"`, `detectedBy: ["adapter"]`, canonical `reddit:<postId>` ID, post title, `frameRef`, `dom` facts, and `duration`) and no standalone `dom:` recorder source.
- [x] A `<shreddit-post>` with `content-href` pointing to `v.redd.it` and no player child yet produces a canonical Reddit DASH source.
- [x] Comment videos inside `<shreddit-comment>` produce a separate `reddit:c-<commentId>` DASH source and suppress their inner `blob:` recorder duplicate.
- [x] Old Reddit `.reddit-video-player-root` elements (reading `data-mpd-url` / `data-hls-url`) inside `.thing` containers produce canonical `reddit:<postId>` DASH sources with post titles and suppress inner `blob:` recorder duplicates.
- [x] Non-Reddit pages do not run Reddit element extraction and behave identically to before.
- [x] DOM detector unit tests verify all cases above in a jsdom environment.
