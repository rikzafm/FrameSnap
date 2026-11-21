# 01: Sniff HLS/CMAF `v.redd.it` streams & fold site-network capture duplicates

**What to build:** Modern Reddit players primarily stream HLS (`HLSPlaylist.m3u8`) and CMAF MP4 segments (`CMAF_*.mp4`) rather than requesting `DASHPlaylist.mpd` directly. Update the Reddit adapter's network detection to recognize any `v.redd.it` media response (HLS playlists, DASH manifests, and MP4 segments), extract its media ID, and emit the canonical bare `DASHPlaylist.mpd` source (deduplicated per media ID). In addition, update capture-duplicate folding in ranking so site-specific network finds (`site !== "generic"` detected via `"network"`) can fold with duration-matching capture-only `<video>` entries, ensuring the DASH download replaces the recorder card rather than being outranked by it.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Reddit network detection produces a canonical `DASHPlaylist.mpd` source when given a `v.redd.it` HLS playlist (`HLSPlaylist.m3u8` / `HLS_*.m3u8`) or MP4 segment (`CMAF_*.mp4` / `DASH_*.mp4`) hit, as well as `DASHPlaylist.mpd`.
- [x] Multiple network hits for the same `v.redd.it` media ID deduplicate into a single Reddit source.
- [x] Non-`v.redd.it` network hits continue to be ignored by the Reddit adapter.
- [x] Capture-duplicate folding folds a site-specific network-detected downloadable source with a duration-matching capture-only `<video>` source, transferring its DOM facts and `frameRef` and removing the recorder duplicate.
- [x] Existing adapter and ranking unit tests pass alongside new tests covering HLS/CMAF network hits and site-network capture folding.
