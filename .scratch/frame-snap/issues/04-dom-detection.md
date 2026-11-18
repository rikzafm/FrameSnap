# 04 — Content script DOM video scan

Status: ready-for-agent
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
