# 03 — Platform wrappers, messaging runtime, settings store

Status: ready-for-agent
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
