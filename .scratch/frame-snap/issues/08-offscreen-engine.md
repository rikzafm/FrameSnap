# 08 — Offscreen document: ffmpeg engine, chunk store, fetch-loop host

Status: ready-for-agent
Blocked by: 03
Spec: ../spec.md §4, §6.3, §6.6

## What
- Offscreen doc lifecycle: created on demand (reasons `BLOBS`, `WORKERS`), closed after 60 s idle with no job.
- Engine: bundled single-thread `@ffmpeg/core`. `run(args[], onProgress, signal)`, where cancel = `terminate()` + reload. Write inputs from `assembleTrack()` blobs, read the output as a Blob, and return a `blob:` URL (revoked after save).
- Host `runFetchPhase` with `OpfsChunkStore` and `fetch`. Forward `onCommit`/`onProgress` to the SW over the `engine` port. Fall back to `MemoryChunkStore` on an OPFS/quota error, and report `resumable: false`.
- `navigator.storage.persist()` once; report `navigator.storage.estimate()` to the SW for `storeCap`.
- GIF: run `buildGifArgs` pass 1 then pass 2.

## Done when
- Engine suite (`npm run test:engine`, Node + `@ffmpeg/ffmpeg`, generated 2 s clips): remux, DASH pair mux, HLS TS → MP4 copy, trim, MP3, GIF.
- Browser test: an OPFS store write → list → read → deleteJob round trip; a write interrupted before close() leaves no file.
- Cancelling mid-encode frees the engine, and the next job runs.
