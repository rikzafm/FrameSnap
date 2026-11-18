# 02 — Core library (model, planning, parsers, resumable jobs)

Status: resolved
Blocked by: none
Spec: ../spec.md §5, §6

## What
Pure TypeScript in `src/core/`, plus the OPFS chunk store in `src/offscreen/opfs-chunk-store.ts`:
- model, errors, messages, filename templates, ranking and merge, estimates, codecs;
- `planDownload`, ffmpeg download and GIF arguments;
- HLS / DASH / XML parsers, trim window;
- chunk planning, track building, the resumable fetch loop, the job state machine, the resume decision, source re-matching, and the cleanup policy.

## Done when
- `npm run typecheck` is clean and `npm test` passes (58 tests).

## Answer
Done on 2026-11-18. Algorithms are documented in spec §6. The resume flow is covered end to end in `tests/unit/resume-flow.test.ts`.
Not covered here: the OPFS store (browser-only, tested in ticket 08), and anything that touches `chrome.*`.
