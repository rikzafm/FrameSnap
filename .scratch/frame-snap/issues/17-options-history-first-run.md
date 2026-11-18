# 17 — Options page, history (last 20), first-run notice

Status: ready-for-agent
Blocked by: 06, 09
Spec: ../spec.md §1 (Q5), §8; source §F5

## What
- Options:
  - defaults: format, quality, audio; file name template with a live `buildFilename` example; image format and quality; clipboard; GIF defaults;
  - on-video button toggle; shortcuts link (`chrome://extensions/shortcuts`); per-site mode list;
  - theme Light/Dark/System, with a derived dark palette signed off by the owner.
- History:
  - last 20 finished jobs, with Re-download (re-detects) and Show in folder;
  - failed resumable jobs at the top: "Stopped at N %", Resume / Discard, partial-data size from `ChunkStore.jobs()`;
  - Clear all (with undo) also empties the chunk store.
- First run: the options page opens with "Only save content you have the right to use." and a privacy summary (including the 7-day partial-data note). The popup shows a banner until it is acknowledged.

## Done when
- Settings round-trip and change the popup defaults; history caps at 20; Clear all leaves no job records or OPFS files.
