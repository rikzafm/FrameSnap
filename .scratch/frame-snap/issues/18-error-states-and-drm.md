# 18 — Error states and DRM UI

Status: resolved
Blocked by: 09
Spec: ../spec.md §6.4 (DRM signals), §6.7; source §7

## What
- Merge DRM signals from DOM (`mediaKeys`), HLS/DASH parsers and a known-DRM host list (Netflix, Disney+, Prime Video, Max, Hulu, Apple TV+, Spotify). Such videos are listed with every action disabled and "This video is protected and cannot be saved". Never attempt a bypass.
- Render every `ErrorCode` from `ERROR_COPY` with its action button: resume / retry / pick / grant / lower-quality. Used in the popup, the picker bar and toasts.
- Warnings: `large-file` (> 500 MB), `too-large` (blocks engine jobs > 1.6 GB, suggests a lower quality or trim), and the GIF low-memory warning.

## Done when
- The fake-EME fixture shows the protected state with no enabled action.
- Each error code renders its copy and action (component test).

## Answer

Built test-first at these seams: `isKnownDrmHost` and `mergeAll`, the error notice component, the popup through the DOM (fake-EME fixture, error codes, warnings), and the picker action bar.

- `src/core/drm.ts`: known DRM hosts (Netflix, Disney+, Prime Video incl. amazon `/gp/video`, Max, Hulu, Apple TV+, Spotify). `rank.mergeAll` marks any source whose page is on one as `protection: "drm"`; DOM (`mediaKeys`) and HLS/DASH signals were already merged (any signal wins).
- `src/ui/error-notice.ts`: `errorNotice(code, handlers)` and `errorToast(code, handlers)` render every `ERROR_COPY` message with its action button (Resume, Try again, Select video, Allow this site, Choose lower quality). A button shows only when a handler exists. Styles in `components.css`.
- Popup (`src/popup/app.ts`): a protected video shows the "protected" copy with Download and Snap disabled (single and list views). `too-large` shows the notice with Choose lower quality (selects the next lower rendition) and disables Download; `large-file` stays a warning. Failed jobs with a `pick`, `grant` or `lower-quality` action show the notice with that button (resume/retry keep their job-row buttons). A denied access request is an error toast with Allow this site.
- `src/content/picker.ts`: selecting a protected video shows the DRM copy in the bar with all actions disabled.
- `src/popup/model.ts`: `gifMemoryWarning(opts, w, h)` returns the low-memory text above a 600 MB working set. The GIF tab (ticket 15) must call it; nothing shows it yet.
- Tests: `tests/unit/{drm,error-notice,error-states}.test.ts`, fixture `tests/fixtures/fake-eme.ts`.

Not done
- Not checked in a real browser. The picker bar renders only the DRM state; other codes are not routed to it (no picker error message type exists yet).
