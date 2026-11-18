# 05 — Tab registry, network sniffer, adapter interface, generic adapter

Status: ready-for-agent
Blocked by: 03
Spec: ../spec.md §4, §6.1, §6.4; source §F1, §F6

## What
- `webRequest.onHeadersReceived` sniffer (observe only), for `.mp4/.webm/.m3u8/.mpd` URLs and media content types, per tab. It records Content-Length, Accept-Ranges and ETag, collapses range requests, and clears on navigation.
- Registry: `Map<tabId, VideoSource[]>` folded with `mergeAll`, mirrored to `chrome.storage.session`, ordered by `rankSources`.
- `SiteAdapter { site, matches(url), detect(ctx), resolve?(src, ctx) }` + registry. `AdapterContext` exposes `parseMaster/parseMedia/parseMpd` from `core/media`.
- Generic adapter: http(s) `<video>` + sniffed URLs. HLS/DASH are expanded into variants and audio tracks on `resolve`, and `live`/`protection` come from the parsers.
- On popup open: send the cached list immediately, then refresh with a DOM scan.
- `chrome.permissions.request` flow for unlisted sites.

## Done when
- Fixture page with an HLS stream: variants are listed with resolution and size estimate within 1 s.
- Unit: an adapter's `detect` runs against fixture HTML and a network log without `chrome.*`.
