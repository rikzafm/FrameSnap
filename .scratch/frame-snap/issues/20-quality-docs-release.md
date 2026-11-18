# 20 — E2E, performance, docs, release packaging

Status: resolved
Blocked by: 04, 06, 07, 09, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19
Spec: ../spec.md §8, §9, §10

## What
- Playwright harness (persistent context, `--load-extension`) and a fixture site, including a server that rotates signed URLs, drops connections at a set byte offset, and changes ETags on demand. Fill e2e gaps.
- Perf: popup first paint < 300 ms, detection list < 1 s. axe-core pass.
- Docs:
  - `docs/testing/manual-<site>.md`;
  - `docs/store/permissions.md` (one line per permission, including storage for resumable data);
  - `docs/known-limitations.md` (from spec §10);
  - `README.md` (Load unpacked, builds, personal vs store, privacy).
- `npm run zip` package and store assets from the logo.

## Done when
- All suites are green, both builds are produced, the store build passes the YouTube check, and the README steps work on a clean Chrome profile.

## Answer

E2E harness, fixture site, perf/axe budgets, docs and release packaging are in. The e2e suite ran in real Chrome (the installed Chrome 157, headless) against the built extension, and it found and fixed one real bug that no unit test could see.

Bug found and fixed
- The offscreen document (`src/offscreen/main.ts`) imported `platform/chrome`, which reads `chrome.tabs`, `chrome.storage` and more when it loads. An offscreen page has only `chrome.runtime`, so the script threw and the engine never connected: every chunked or engine download sat at "Waiting 0 %". A second latent bug sat behind it: `connectWithReconnect` runs `onConnect` synchronously, before `host` existed (temporal dead zone), and the `engine/ready` reply would have been posted before the port variable was set. `main.ts` now uses `chrome.runtime.connect` directly, creates the host first and posts on the port handed to `onConnect`. Regression test: `tests/unit/offscreen-main.test.ts` (loads the module with only `chrome.runtime` stubbed).

Harness (`tests/e2e/`, run with `npm run build` then `npm run test:e2e`, config `vitest.e2e.config.ts`)
- `harness.ts`: persistent-context Chrome. Branded Chrome ignores `--load-extension` and Playwright adds `--disable-extensions`, so the harness drops that default arg and loads the build over CDP (`Extensions.loadUnpacked`, flag `--enable-unsafe-extension-debugging`). It copies the build beside the profile and adds `*://127.0.0.1/*` to `host_permissions` in the copy only, because a headless run cannot answer the permission prompt. `openPopup(page)` opens the popup page with `chrome.tabs.query` pinned to the fixture tab. `visit(url)` loads and reloads once (see below). `E2E_CHANNEL=chromium` uses Playwright's bundled Chromium (it could not be run here: the OS blocked the downloaded chrome.exe).
- `fixture-server.ts` (unit-tested in `tests/unit/fixture-server.test.ts`): Range and If-Range, a rotating signature (`rotateSignature`, or `rotateAfterBytes(n)` for an expiry mid-download), ETag changes (`changeEtag`), a one-shot connection drop at a byte offset (`dropAt`), and serving a given body. Requests from the page's own `<video>` (`sec-fetch-dest: video`) do not count towards rotation or drops.
- `clip.ts` (`padMp4` unit-tested): a real 1920x1080, 6 s H.264/AAC clip made once with the engine's ffmpeg.wasm in Node and cached in the temp folder; a trailing `free` box pads it to 64 MB for the chunked route.

E2E results (all pass)
- `smoke`: popup lists the fixture video, download is byte-identical (sha256).
- `resume` (spec section 9 scenario, 64 MB, link expires after about 28 MB): job fails as `expired` with 75 % kept; reload gives a new signed URL; Resume finishes with an identical hash and fetches at most the 3 missing 8 MB chunks, all with If-Range. A changed ETag restarts from zero with an identical hash. After a full browser relaunch on the same profile the banner resumes and the hash matches.
- `snap-gif`: Snap saves a 1920x1080 PNG (about 150-290 ms click to saved) while currentTime advances; the GIF flow makes a 480 px, 15 fps GIF, Save writes a `GIF` file 480 wide, and the page has no long task over 200 ms.
- `quality`: popup first paint 32-72 ms (budget 300), detection list 15-30 ms (budget 1 s), axe-core clean on the popup (light and dark) and the options page.

Release and docs
- `npm run zip` builds the store build, runs `check:store`, and writes `release/frame-snap-0.1.0.zip` (`scripts/zip.ts`, dependency-free, deterministic, refuses a store zip with YouTube strings; unit-tested and checked with Python's zipfile). `npm run zip:personal` packages `dist-personal`. `npm run store:assets` writes the 128 px icon, 440x280 and 1400x560 promo tiles and a 1280x800 popup screenshot (taken from the real build) to `release/store-assets/` (git-ignored).
- Docs: `README.md`, `docs/store/permissions.md`, `docs/known-limitations.md`, `docs/testing/manual-generic.md` and `manual-youtube.md` (reddit, x and discord already existed). `tests/unit/docs.test.ts` checks every manifest permission has its line, the 7 day note sits under `storage`, the store doc never names YouTube, README only names real npm scripts, and every spec section 10 limit is listed.
- `vite.config.ts` now carries `test.exclude` for `.claude/**` (and `dist*`, `release`), so other worktrees' tests no longer run here. It had to go in `vite.config.ts`, not a separate `vitest.config.ts`, which would have dropped the `__YOUTUBE__` define.

Not run or open
- The keyboard shortcut itself (`chrome.commands`) cannot be triggered in an automated Chrome; the snap e2e uses the popup path. The 300 ms budget is asserted as under 500 ms on that path (one hop more) and measured about 150-290 ms. A shortcut run stays in the manual checklist.
- Real site runs (Reddit, X, Discord, YouTube, a live MSE stream, DRM) and the manual checklists were not run; they need real accounts and sites. Only the generic fixture and the personal build smoke test ran in Chrome.
- The README steps were exercised as the harness does them (fresh profile, built `dist/`, personal build too), but clicking through `chrome://extensions` Load unpacked was not done by hand.
- Found while testing, documented in known limitations and not changed: the first page opened right after install is not seen by the webRequest sniffer (a reload is), and a generic page with signed URLs and no duration cannot be re-matched on resume (the popup asks the user to pick the video again).
- In a hidden tab Chrome stalls frame reads, so the snap test brings the page to the front first (the real popup does not hide the page).
- CI workflow: added in the review fixes below.

## Review fixes

Spec findings
1. Fixed. A SW restart no longer clobbers live jobs: `recover()` asks the offscreen host (`engine/status` -> `engine/running`) what it still runs and adopts those jobs (record stays `running`, events carry on). The rest become resumable failures; if the host cannot be asked they fail as before, which is safe because the host aborts an older run of a job id when a resume starts it. Adopted jobs need the ffmpeg seeks and the rule id, so `JobRecord` now stores `seeks` and `ruleId`. GIF jobs are not adopted (their preview blob and size facts do not survive the worker). Tests: `engine-host`, `resume-wiring`.
2. Fixed. `recover()` removes every session rule not owned by an adopted job, and rules carry `tabIds: [-1]` (requests no tab made: offscreen document, service worker, downloads), so they never touch an open page.
3. Fixed. `src/background/popup-commands.ts` is one table and one error path: a throwing download/gif/save/resume/discard/cancel emits a `failed` job event (under the job's own id when it has one). The picker's Download action does the same.
4. Fixed in part. `runResume` now emits `resume-needs-pick` (job stays resumable) instead of throwing `not-found`; this branch is defensive because `runResume` is only called with a found match, so it has no test. `resumeJob` and `resumePicked` compare the tab to the canonical job page (a pick from a tab on another page now fails resumable instead of continuing).
5. Fixed. `commands` removed from `permissions` (the manifest key stays); `docs/store/permissions.md` and its tests updated. The `<all_urls>` content script and `clipboardWrite` are kept (tickets 01, 04, 16) and justified in permissions.md.
6. Fixed. `.github/workflows/ci.yml` runs typecheck, lint, test, test:engine, both builds and check:store. The browser and e2e suites are not in CI (they need Chromium installs).
7. Fixed. The shortcut snaps the tab's best-ranked video with a page element, once (`bestSource`); it broadcasts only when no video element is known.
8. Fixed the ticket 12 Answer. `tests/e2e/resume.test.ts` covers an expired signature failing at about 44 %, reload and resume (only missing bytes, identical hash), a changed ETag restarting, and a browser relaunch after a failure. Missing: a real kill (SW or browser killed while the fetch runs) and the adopt-after-SW-restart path in real Chrome; both are covered only at the orchestrator seam.

Standards findings
9. Fixed. `.agents/` is in `.gitignore`; CLAUDE.md and AGENTS.md now list `.agent/` and `.agents/`.
10. Fixed. New `src/platform/extension.ts` (no `chrome.*` access at import, so content scripts can load it, which `platform/chrome.ts` cannot) wraps the calls in content, bridge, popup, options, the SW entry and `snap-wire.ts` (`captureVisibleTab`, `commands`). `src/offscreen/main.ts` is left as documented.
11. Mostly fixed: one `createTabRegistry`; `adapterContext.fetchText` shares `src/background/fetch-text.ts` with the orchestrator; the two `hostOf` are `hostnameOf` (download.ts) and `originLabel` (options); one `selectInPopup` helper; stray `PICKER_SELECTION_KEY` export removed; redundant casts dropped (the DNR enum casts stay, they are needed outside Chrome); the Q7 comment is spelled out; `keptRatio` lives in `core/jobs/job.ts`; the page-report `raw.t` ladder is a table. Skipped: splitting `createDownloadOrchestrator` into modules (its state is shared through one closure, so a split is a refactor of its own).
