# 05 — Tab registry, network sniffer, adapter interface, generic adapter

Status: resolved
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

## Answer

Built test-first at these seams: generic adapter `detect`/`resolve` (pure, fixture HTML + network log), sniffer, tab registry (injected session area), media service (popup-open flow), site-access flow.

- `src/adapters/`: `types.ts` (`SiteAdapter`, `AdapterContext`, `DetectContext`), `generic.ts` (http(s) `<video>` + sniffed URLs; HLS/DASH expanded on `resolve`, `live`/`protection`/duration from the parsers), `registry.ts` (`pickAdapter`), `html.ts` (`<video>` extraction from HTML for no-DOM contexts).
- `src/background/sniffer.ts`: observe-only; extensions + media content types, Content-Length / Accept-Ranges / ETag, range requests collapsed (total from Content-Range), cleared on top-frame navigation.
- `src/background/registry.ts`: per-tab `mergeAll` + `rankSources`, mirrored to `chrome.storage.session`, serialised writes, restores after SW restart.
- `src/background/media-service.ts`: popup open sends the cached list, then DOM scan + manifest expansion, then the refreshed list. Wired in `src/background/index.ts` (`media/list`, `webRequest.onHeadersReceived`, tab loading/removal).
- `src/content/scan.ts` + `dom/scan` message (`src/core/messages.ts`): content script reports DOM sources through the page's adapter.
- `src/platform/site-access.ts`: `requestSiteAccess` (`permissions.request` for unlisted origins, then injects the content script). Must be called from a popup click; the popup wiring belongs to the popup ticket.
- Fix in `src/core/rank.ts`: DASH variants share the MPD URL, so variant dedupe now keys on URL + id for `dash` (otherwise all representations collapsed into one).
- Tests: `tests/unit/{generic-adapter,sniffer,media-service}.test.ts`, fixtures in `tests/fixtures/hls-page.ts`. The HLS fixture lists variants with resolution and size estimate with no network wait.
