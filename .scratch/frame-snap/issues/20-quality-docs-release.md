# 20 — E2E, performance, docs, release packaging

Status: ready-for-agent
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
