# 03 — Platform wrappers, messaging runtime, settings store

Status: resolved
Blocked by: 01
Spec: ../spec.md §2 (core rule), §4, §6.8

## What
- `src/platform/`: thin, mockable wrappers over `chrome.runtime`, `tabs`, `storage`, `downloads`, `scripting`, `offscreen`, `alarms`, `declarativeNetRequest`, `permissions`.
- Port helpers: a named popup port per tab, an `engine` port to offscreen, auto-reconnect, and `isPopupToWorker`-style guards at every receiver (add guards for the other unions in `core/messages.ts`).
- `src/core/settings.ts` (pure defaults + migration) and `src/platform/settings-store.ts` (`get/set/subscribe` over `chrome.storage.local`).
- `src/background/job-store.ts`: read/write `jobs/<id>` records, batch `commitChunks` writes to ≤ 1/s, list all jobs.

## Done when
- Unit: guards reject malformed input; settings migrate from empty; job-store batching coalesces 100 commits into ≤ 2 writes (fake timers).
- In the loaded extension, a demo message makes the popup → SW → content → SW round trip.

## Answer

Built test-first at these seams: message guards, settings migration, settings store, job store, port helper, SW router.

- `src/core/messages.ts`: guards for every union (`isPopupToWorker`, `isWorkerToPopup`, `isJobEvent`, `isWorkerToContent`, `isContentToWorker`) plus a `demo/ping` / `demo/pong` round trip.
- `src/core/settings.ts`: `DEFAULT_SETTINGS`, `migrateSettings` (empty/garbage/legacy to valid current).
- `src/platform/chrome.ts`: thin wrappers (runtime, tabs, storage, downloads, scripting, offscreen, alarms, declarativeNetRequest, permissions).
- `src/platform/ports.ts`: `popupPortName(tabId)`, `ENGINE_PORT`, `connectWithReconnect` (guarded, exponential backoff).
- `src/platform/settings-store.ts`: `get/set/subscribe` over `chrome.storage.local`.
- `src/background/job-store.ts`: `jobs/<id>` get/put/list/remove; `commitChunks` batched to one write per second (100 commits -> 1 write in the test).
- `src/background/router.ts` + entry wiring: popup port -> SW -> `tabs.sendMessage` -> content -> SW -> popup. The popup sets `data-demo` on `<html>` on success.
- Tests: `tests/unit/{messages,settings,settings-store,job-store,ports,demo-route}.test.ts`.
- Not verified: the loaded-extension round trip in a real Chrome (build output only). `format:check` already flagged existing files and was not enforced.
