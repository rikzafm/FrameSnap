# 06 — Popup UI (single, list, empty, Video tab, jobs, resume banner)

Status: ready-for-agent
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
