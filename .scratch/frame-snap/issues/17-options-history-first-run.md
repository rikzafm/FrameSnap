# 17 — Options page, history (last 20), first-run notice

Status: resolved
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

## Answer

Built test-first at four seams: settings migration, the options data module, the options page through jsdom (axe clean), and the popup (defaults and first-run banner).
- `src/core/settings.ts`: new fields `defaultQuality` ("best" or a height cap `h720`, resolved per video by `resolveDefaultQuality`), `defaultAudio`, `gif` defaults, `acknowledged`. The popup and the picker's Download start from them.
- `src/options/app.ts` (+ `main.ts`, `options.css`, `index.html`): defaults, file name template with a live `buildFilename` example, image format/quality, clipboard and on-video button (same `snap/prefs` key the popup uses), GIF defaults, shortcuts link, theme (applied at once), Sites (granted origins with Revoke via `permissions.remove`, remembered per-site modes with Forget), Stopped downloads above History, History (last 20, Re-download, Show in folder), supported-sites footer.
- `src/options/data.ts`: history slice, stopped jobs with partial size from `ChunkStore.jobs()`, Discard, Clear all with Undo. Clear all empties history and every finished job record at once; the OPFS chunks are deleted when the 8 s undo window ends or the page closes. Running jobs are left alone.
- First run: `onInstalled` opens the options page; it shows the use notice and privacy summary (7-day partial data). The popup shows a banner until "Got it" sets `acknowledged`.
- `HistoryEntry` gained `downloadId` for Show in folder. Platform wrappers: `downloads.show`, `permissions.getAll`, `tabs.create`.

Not done or open
- Resume (and Re-download) open the page in a tab; the resume banner in the popup there continues the job (ticket 10's flow). There is no direct resume from the options page.
- The dark palette in `tokens.css` is unchanged; owner sign-off is still outstanding.
- Quality default is a height cap, since variant ids differ per video. GIF defaults are stored but the GIF tab (ticket 15) must read them.
- Not run in a loaded Chrome; Clear all is verified against the in-memory chunk store, not OPFS.
