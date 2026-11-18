# 06 — Popup UI (single, list, empty, Video tab, jobs, resume banner)

Status: resolved
Blocked by: 04, 05
Spec: ../spec.md §7; source §5 mockups "Popup, default", A, C; §6 tokens

## What
- Components: button, select row, segmented switch, switch, chip, radio card, tabs, progress, toast. All keyboard-operable, ≥ 44 px, with aria-labels on icon buttons.
- Views:
  - single video: summary card, Video/GIF/Screenshot tabs, Format/Quality/Audio/Trim/File name rows, Download + Snap;
  - list: "N videos found", radio cards, "Not listed?" link;
  - empty state: 3 steps, Remember switch, Start picking.
- Format/Quality rows read `planDownload` output: show `estimate`, the `large-file`/`too-large` warnings and an `assumed-codecs` hint. The file name preview uses `buildFilename`.
- Job row: phase label, %, Cancel. A failed job shows `ERROR_COPY[code]` and **Resume** ("62 % kept", from `keptRatio`) or Retry.
- Resume banner above the list for `resumableOn(jobs, canonicalPageUrl(tab.url))`: one job → "Download stopped at N %: <title>" with Resume / Discard; several → "N downloads can be resumed", expanding on click.
- Per-site mode memory; GIF and Screenshot tabs are empty shells (filled by 15/16).

## Done when
- Matches the three popup mockups; axe-core clean; keyboard-only flow works; first paint < 300 ms.

## Answer
Popup UI built test-first (seams: pure view models; the popup controller through the DOM with jsdom and axe-core).
- `src/popup/model.ts`: `describeDownload` (planDownload estimate, `large-file`/`too-large`/`assumed-codecs` warnings, `buildFilename` preview), `qualityChoices`, `jobRowModel` (phase, %, Cancel, Resume "N % kept" / Retry, `ERROR_COPY`), `resumeBanner`.
- `src/ui/components.ts` + `components.css`: button, icon button, select row, segmented, switch, chip, radio cards, tabs, progress, toast (keyboard-operable, 44 px, aria-labels).
- `src/popup/app.ts`: single, list and empty views, job rows, resume banner (single and expandable multi), Remember switch calling `requestSiteAccess` from the click handler, Start picking, Not listed?. GIF and Screenshot tabs are empty shells.
- `src/popup/mode-memory.ts`: per-site mode memory. `src/popup/main.ts`: wiring (port, settings, stored jobs via `resumableOn(jobs, canonicalPageUrl(tab.url))`, theme).
- Tests: `tests/unit/popup-model.test.ts`, `tests/unit/popup-app.test.ts` (axe-core clean per view, keyboard flows). Added `axe-core` devDependency.
- Not measured: first paint under 300 ms (shell is static HTML, data renders after); visual match to mockups was not checked in a browser.
