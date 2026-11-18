# 04 — Content script DOM video scan

Status: resolved
Blocked by: 03
Spec: ../spec.md §5, §6.1; source §F1

## What
- Scan `<video>` in the document, in open shadow roots (recursively) and in same-origin iframes (`all_frames`, `match_origin_as_fallback`).
- Emit a `VideoSource` per element:
  - `dom` facts (visible ratio, rect, playing), `frameRef` (WeakMap element key), `duration`, size;
  - thumbnail (poster, or a 160 px canvas grab when the canvas isn't tainted);
  - `protection: "drm"` when `video.mediaKeys` is set;
  - a progressive variant from an http(s) `currentSrc`.
- Ids: `dom:` + `fnv1a(currentSrc || frameUrl + elementKey)` (`core/jobs/chunks.ts`).
- Live updates: debounced `MutationObserver` + `loadedmetadata`/`play` → `dom/report`.
- `scan` request answered within 150 ms.

## Done when
- A fixture page with 3 videos (one in a shadow root, one in an iframe) reports 3 sources. A 4th added by script appears within 300 ms.

## Answer

Built test-first at three seams: the detector, the content message handler, the manifest.

- `src/content/dom-detect.ts`: `createDomDetector({document, frameUrl, emit})` with `scan()`, `start()`, `stop()`, `resolve(elementKey)`. Walks the document and open shadow roots recursively (new shadow roots are observed too). Emits a `VideoSource` per `<video>`: `dom` facts, `frameRef` (WeakMap element key `e<n>`), duration, poster or 160 px canvas thumbnail (tainted canvas ignored), `protection: "drm"` when `mediaKeys` is set, progressive variant for http(s) `currentSrc`, id `dom:` + `fnv1a(currentSrc || frameUrl + elementKey)`. `start()` reports immediately, then via a 100 ms debounced `MutationObserver` plus `loadedmetadata`/`play`/`pause`/`ended`; unchanged reports are suppressed.
- Iframes: each frame runs its own detector (manifest `all_frames: true`, `match_origin_as_fallback: true`), so a same-origin iframe reports its own videos with its own `frameUrl`. The content script cannot know its frame id, so `frameRef.frameId` is 0 and the service worker must fill it from `sender.frameId` (SW aggregation work).
- `src/content/handler.ts` + `src/content/index.ts`: synchronous `dom/scan` to `dom/report` reply; `src/core/messages.ts` gains `{t: "dom/scan"}` in `WorkerToContent`.
- Tests: `tests/unit/dom-detect.test.ts` (jsdom; added `jsdom` devDependency). A fixture of 3 videos (top, shadow root, iframe) reports 3; a 4th added by script appears within 300 ms (fake timers).
- Not verified: real Chrome behaviour (canvas thumbnails, real iframes, `match_origin_as_fallback`); jsdom has no layout or canvas.
