# Frame Snap — Implementation Spec

Status: ready-for-agent
Source: `Frame-Snap-Specification.pdf` v1.0 (Manifest V3). Refs like §F1 or §6 point into that document.
Revision 2 (2026-11-18): the core library in `src/core/` is written and tested. This spec
describes its algorithms as built, and the remaining work as tickets in `issues/`.

Frame Snap is a Chrome MV3 extension that finds videos on the current tab and lets the user
(a) download them in a chosen format and quality, (b) turn a time range into a GIF and
(c) snap the exact frame on screen. Everything runs locally; nothing is uploaded. A failed
download can be resumed later, even after the page is refreshed or the browser restarts.

---

## 1. Decisions (resolved 2026-11-18)

| # | Question | Decision |
|---|---|---|
| Q1 | Bundler | Vite + `@crxjs/vite-plugin` |
| Q2 | Firefox | Chrome/Chromium only for v1. Browser APIs stay behind `src/platform/`. |
| Q3 | YouTube adapter | Included in the single build (`npm run build`, `dist/`). The extension is not published to the Chrome Web Store, so there is no separate store build. |
| Q4 | ffmpeg.wasm licence | `@ffmpeg/core` includes libx264 (GPL), so the repo relicenses from MIT to GPL-3.0 (ticket 01). |
| Q5 | Theme setting | Light / Dark / System. The dark palette is derived from Paper Ink, and the owner signs off on it. |
| Q6 | GIF from the in-page bar | `chrome.action.openPopup()` on the GIF tab, with that video selected. |
| Q7 | Referer/Origin headers | Add `declarativeNetRequestWithHostAccess`. Session rules are set per job and removed afterwards. |
| Q8 | Unlisted sites | `optional_host_permissions: ["<all_urls>"]`, requested at runtime. `activeTab` covers one-off detection. |
| R1 | Resume (added by the owner) | Failed downloads resume after a refresh, popup close, SW restart or browser restart, keeping fetched bytes (§6.6). |

---

## 2. Tech stack and repo layout

- TypeScript strict (`noUncheckedIndexedAccess`), Vite + crxjs, no UI framework (§1 of source).
- ffmpeg.wasm single-thread core, bundled. CSP `script-src 'self' 'wasm-unsafe-eval'`.
- Fraunces 600 + Inter 400/500/600 as local woff2 files (OFL licence). No font CDN.
- Vitest for unit tests (in place). Playwright for e2e (ticket 20).

```
src/
  core/                 ← DONE. Pure TS, no chrome.* or DOM-only APIs. Runs in SW, offscreen, content, Node.
    model.ts            VideoSource, Variant, options, limits
    errors.ts           AppError codes, user copy, HTTP → error mapping
    messages.ts         typed messages + guards
    filename.ts         {title} {site} {date} {resolution} {time} templates, sanitiser
    rank.ts             detection merge + ranking + best variant
    estimate.ts         download and GIF size estimates
    codecs.ts           codec families, container compatibility, output metadata
    plan.ts             planDownload (§F2 decision procedure)
    ffmpeg-args.ts      download and two-pass GIF command lines
    media/xml.ts        minimal XML reader (the SW has no DOMParser)
    media/hls.ts        master + media playlist parser
    media/dash.ts       MPD parser (template / timeline / list / base)
    media/window.ts     trim window over segments
    jobs/chunks.ts      chunk keys, byte-range and segment chunk plans, layout hash
    jobs/tracks.ts      plan inputs + manifests → chunk plans + ffmpeg seeks; probe parsing
    jobs/fetch-loop.ts  resumable fetch phase
    jobs/job.ts         job record state machine + resume decision
    jobs/source-ref.ts  canonical page URL, source/variant re-matching, validators
    jobs/store.ts       ChunkStore contract + in-memory store + assembly
    jobs/cleanup.ts     chunk-store eviction policy
  offscreen/
    opfs-chunk-store.ts ← DONE. OPFS-backed ChunkStore.
    (engine.ts, index.html … ticket 08)
  background/  content/  main-world/  popup/  options/  adapters/  platform/  ui/   ← tickets
tests/
  unit/                 ← 58 tests over src/core (fetch loop, resume flow, plan, parsers, misc)
  helpers/fake-cdn.ts   in-memory CDN: ranges, ETag/If-Range, signed URLs, scripted failures
assets/logo/            vector logo masters
```

Rule: **`src/core` never imports `chrome.*`, `document`, `window` or OPFS.** Anything that needs
them goes in a component folder and is injected into core (`HttpGet`, `ChunkStore`). This keeps
every algorithm unit-testable in Node.

Commands: `npm run typecheck`, `npm test`. Build commands come with ticket 01.

---

## 3. Logo and icons

From the supplied "Viewfinder" mark: a vermilion rounded square, four cream corner brackets and a centre lens dot.

- [`assets/logo/frame-snap.svg`](../../assets/logo/frame-snap.svg): 128 grid, `rx 32`, 8 px round-capped brackets, dot r 11. Colours `#C23A08` / `#FAF8F3`.
- [`assets/logo/frame-snap-16.svg`](../../assets/logo/frame-snap-16.svg): hinted for 16 px, with heavier strokes.
- Ticket 01 rasterises them to 16/32/48/128 PNGs and a 440×280 store promo image. The logo is used in the toolbar, the popup and options headers, and the first-run notice. The shutter flash reuses the bracket shape.

---

## 4. Architecture

```
Popup / Options ──port──► Service worker ──port──► Offscreen document
                          • message hub              • ffmpeg.wasm engine
                          • tab registry (core/rank) • OPFS chunk store
                          • adapters + sniffer       • fetch loop (core/jobs)
                          • job orchestrator         • blob: URL for saving
                          • job records (storage)
                          • chrome.downloads
                               ▲
Content script (isolated) ─────┘  DOM scan, picker, frame capture
   ▲ postMessage (nonce)
Main-world script                 fetch/XHR taps (X), MSE hooks (blob:)
```

| Component | Owns | Uses from core |
|---|---|---|
| Service worker | registry, adapters, sniffer, job orchestration, job-record persistence, downloads, commands, cleanup alarm | `rank`, `plan`, `jobs/job`, `jobs/source-ref`, `jobs/tracks`, `jobs/cleanup`, `media/*`, `messages` |
| Offscreen | ffmpeg engine, chunk store, fetch loop, assembly, `blob:` URLs | `jobs/fetch-loop`, `jobs/store`, `ffmpeg-args` |
| Content | DOM scan, picker overlay, on-video button, frame capture | `model`, `rank.score`, `filename` |
| Popup/Options | UI | `messages`, `estimate`, `errors.ERROR_COPY`, `filename` |

The fetch loop runs in the **offscreen document**. The SW can be suspended after 30 s idle, and
fetches must outlive it. The SW owns job records and reacts to `onCommit`/progress messages.

---

## 5. Data model (`src/core/model.ts`)

- `VideoSource { id, site, title, pageUrl, duration?, variants[], audioTracks[], headers?, frameRef?, protection, detectedBy[], dom? }`
  is the §F6 adapter contract. Two optional fields were added: `dom` (visibility facts used for ranking) and `protection`.
- `Variant { id, kind: progressive|hls|dash|mse-capture|recorder, url, container, videoCodec?, audioCodec?, width?, height?, bitrate?, sizeBytes?, hasAudio, acceptsRanges?, live? }`.
- Options: `DownloadOptions { format, quality ("best" | variant id), audio: keep|remove|only, trim?, frameAccurate?, filenameTemplate }`,
  `GifOptions { trim, fps, width, loop (total plays, 0 = forever), dither }`.
- Limits: `GIF_MAX_SECONDS = 30`, `LARGE_FILE_BYTES = 500 MB`, `CHUNKED_MIN_BYTES = 50 MB`, `ENGINE_MAX_BYTES = 1.6 GB`, `CHUNK_BYTES = 8 MB`.

---

## 6. Core algorithms (built)

### 6.1 Detection merge and ranking — `rank.ts`

- **Merge** (`mergeAll`): finds are folded by id. A find whose variant URL already belongs to another
  id is folded into that entry, so a sniffed `.m3u8` and the adapter card for the same post become
  one item. When an adapter find meets a DOM/network find, the adapter's id wins (adapter ids are
  canonical and survive refreshes). Variants are deduped by URL and sorted by height, then bitrate.
  Any DRM signal marks the merged source as DRM.
- **Score** (`score`): `visible area × (playing ? 2 : 1) + log2(1 + height)`. Network-only finds get
  only the height term, so they rank below anything visible. DRM sources get −1.
- **Pre-select**: the first entry from `rankSources`. **Best available**: `bestVariant` (height, then bitrate).

### 6.2 Download planning — `plan.ts`

`planDownload(source, options) → DownloadPlan` decides, without I/O:

1. DRM → throw `drm`. "Audio only" with a video format becomes M4A, and MP3/M4A always mean audio only.
2. **Inputs**
   - Audio only: the best separate audio track; otherwise the smallest muxed rendition that has audio.
   - Video: the chosen variant (or best). If audio is kept and the variant has none, add the best separate audio track (Reddit/YouTube DASH).
3. **Stream ops** (`copy | encode | drop`): copy when the codec family fits the output container (`codecs.ts` table) and no frame-accurate trim is asked for; otherwise encode. Unknown codecs are assumed from the container and flagged `assumed-codecs`.
4. **needsEngine**: two inputs, non-progressive input, trim, any encode, audio removal, audio-only output, or a container change.
5. **Route**
   - `capture`: MSE / recorder inputs
   - `segments`: any HLS/DASH input
   - `chunked`: progressive input that needs the engine, or one that is ≥ 50 MB with Range support
   - `direct`: everything else, handed to `chrome.downloads`
6. **Resumable** unless the route is direct or capture, or an input is live.
7. **Estimate and warnings**: `large-file` above 500 MB; `too-large` above 1.6 GB when the engine is needed.

| Example | Route | Engine | Video/Audio | Resumable |
|---|---|---|---|---|
| 10 MB MP4 → MP4 | direct | no | copy/copy | no |
| 60 MB MP4 with ranges → MP4 | chunked | no | copy/copy | yes |
| MP4 → MKV | chunked | yes | copy/copy | yes |
| MP4 → WEBM | chunked | yes | encode/encode | yes |
| Reddit DASH video + audio → MP4 | segments | yes | copy/copy | yes |
| HLS TS + trim → MP4 | segments | yes | copy/copy (+`aac_adtstoasc`) | yes |
| any → MP3 | chunked/segments | yes | drop/encode | yes |
| live HLS | segments | yes | — | no |

### 6.3 ffmpeg command lines — `ffmpeg-args.ts`

- Download: per-input `-ss/-t` (input seeking), `-map 0:v:0`, `-map <audio input>:a:0?`.
  - Video encode: `libx264 veryfast crf 23 yuv420p`, or `libvpx-vp9 realtime cpu-used 8 crf 33` for WEBM.
  - Audio encode: `aac 160k`, `libopus 128k` or `libmp3lame q2`.
  - Container fixes: `aac_adtstoasc` when copying TS audio into the MP4 family; `+faststart` for MP4/MOV/M4A; `-avoid_negative_ts make_zero` when trimming.
- GIF: two passes. Pass 1 is `fps,scale=W:-2:flags=lanczos,palettegen=stats_mode=diff`. Pass 2 is `paletteuse=dither=sierra2_4a|none:diff_mode=rectangle`. Loop: total plays P → `-loop` 0 (forever) / −1 (once) / P−1.

### 6.4 Media parsers — `media/`

- **HLS** (`hls.ts`)
  - Master playlists: variants sorted by height then bandwidth (prefers AVERAGE-BANDWIDTH), alternate renditions, and `audioRenditionFor`.
  - Media playlists: sequence numbers, start times, BYTERANGE (with implicit offsets), `EXT-X-MAP`, keys, and live vs VOD (ENDLIST or PLAYLIST-TYPE:VOD).
  - Protection: **DRM = any key whose method isn't AES-128 or whose KEYFORMAT isn't `identity`**. Plain AES-128 is supported, with the default IV taken from the sequence number.
- **DASH** (`dash.ts`): uses the first Period and flags `multiPeriod`.
  - BaseURL is inherited MPD → Period → AdaptationSet → Representation, and SegmentTemplate attributes merge down the same chain.
  - Addressing: `$Number$` with a fixed duration; `SegmentTimeline` (`t`, `d`, `r`, including `r=-1`) with `$Time$`; `SegmentList` with ranges; SegmentBase or a bare BaseURL as one `whole` file.
  - **Any `ContentProtection` → DRM.** This is safer than the original "except mp4protection" rule, because mp4protection also means the stream is encrypted.
- **XML** (`xml.ts`): small, namespace-stripping reader, because MV3 service workers have no `DOMParser`.
- **Trim window** (`window.ts`): keep the segments that overlap `[start, end)`, and report `offset` (seconds into the first kept segment) and `length` for ffmpeg `-ss/-t`. Only those segments are fetched.

### 6.5 Track building — `jobs/tracks.ts`

`buildTracks(plan, resolved[])` turns each plan input, plus what the SW fetched or probed for it, into a `TrackPlan` (chunk list) and an ffmpeg seek:

| Input | Chunks | Seek |
|---|---|---|
| progressive, ranges + size known | `r<start>-<end>` 8 MB ranges | absolute trim |
| progressive, no ranges | `whole` | absolute trim |
| HLS | `init` (EXT-X-MAP) + `s<sequence>` for the trim window; AES-128 carries `{keyUrl, ivHex}` | window offset |
| DASH template/list | `init` + `n<Number>` / `t<Time>` / `i<index>` for the window | window offset |
| DASH whole file (Reddit) | byte ranges, or `whole` | absolute trim |

`probeFromHeaders` reads a HEAD or `Range: bytes=0-0` response: total size (from Content-Range or Content-Length), Range support, ETag and Last-Modified.

### 6.6 Resumable jobs — `jobs/`

**Chunk keys never contain URLs.** The same media chunked the same way gives the same keys and the
same `layoutHash`, even when every signed URL changed on refresh. That property is what makes resume work.

**Persisted state**
- *Job record* (`job.ts`, `chrome.storage.local` key `jobs/<id>`, JSON-safe): status, phase, `SourceRef`, options, plan, per-track `{keys, committed, validators}`, progress, attempts, resumable flag, error.
- *Chunks* (`ChunkStore`): `/jobs/<jobId>/<trackId>/<key>` in OPFS (`opfs-chunk-store.ts`). `createWritable()` commits atomically on `close()`, so a file that exists is complete.
- *Validators* per track: `{etag?, lastModified?, contentLength?, layout}`.

**State machine** (`job.ts`): `queued → running → done | failed | cancelled`, and `failed → running` on resume.
- `fail()` keeps the job resumable only if the plan is resumable and the error is retryable.
- `recoverInterrupted()` turns `running`/`queued` records into resumable failures when the SW or browser starts.
- `commitChunks()` keeps `committed` in plan order. The caller batches these writes to ≤ 1/s.

**Fetch loop** (`fetch-loop.ts`, `runFetchPhase`)
1. *Reconcile*: list the store. A chunk counts as done only if it is present and has the expected size. Store truth wins over the record, which covers a crash between writing the chunk and saving the record.
2. *Queue*: the missing chunks in plan order. A pool of 3 workers (configurable) works through it, and the first hard error aborts the rest.
3. *Request*: the job's headers, plus `Range` for byte chunks and `If-Range` (strong ETag, else Last-Modified).
4. *Verify*:
   - a range request must get 206; a 200 means `changed` if If-Range was sent, otherwise `unsupported`;
   - the total in `Content-Range` must equal the stored `contentLength`, else `changed`;
   - the body length must equal the chunk size, else a short read (retryable).
5. *Decrypt* HLS AES-128 with WebCrypto (one key fetch per key URL), *write* to the store, then call `onCommit` and `onProgress`.
6. *Retry*: `TypeError`, 408/425/429/5xx and short reads retry with exponential backoff (500 ms × 2ⁿ, 3 times). 401/403/404/410 become `expired`, with no retry: the URL is stale, so resume re-detects it.
7. *Cancel*: the abort signal stops the workers. Committed chunks stay in the store.

**Resume decision** (`decideResume`), run by the SW after the page is re-detected:
1. Find the page's failed jobs with `resumableOn(jobs, canonicalPageUrl(tab.url))`. Canonicalising strips the hash and tracking params, sorts the query, and folds host aliases (twitter.com → x.com, old./new./www.reddit.com → reddit.com).
2. Re-match the video with `matchSource(ref, freshSources)`:
   - by `sourceId` (adapter ids survive refreshes);
   - else the single same-site, non-DRM source whose duration is within ±0.5 s; more than one gives `ambiguous`;
   - then the variant: same id, else same kind + height + codec family, with bitrate within 10 % (nearest wins).
3. Run `planDownload` again with the stored options against the fresh source, then probe or fetch the manifests and call `buildTracks` to get the fresh `TrackPlan`s and validators.
4. Decide:
   - `pick` when the match is `not-found`/`ambiguous`. The UI opens the picker, and a picked video is accepted if its duration is within ±0.5 s (`acceptsPicked`).
   - `restart` when the track count, roles, layout hash, size or strong validators differ (`sameMedia`). The store is wiped and the UI shows "The video changed since the last attempt".
   - `continue` otherwise, keeping the committed keys that still exist in the fresh layout. `keptRatio` feeds the "62 % kept" label.
5. Run `runFetchPhase` with the fresh chunk URLs. Only the missing chunks are fetched, and the If-Range check stops a silent mix of two different files.
6. If every chunk was already fetched and the engine failed, skip straight to the engine.

**Cleanup** (`cleanup.ts`, run on SW start and from a daily `chrome.alarms` alarm):
- evict orphans, done/cancelled jobs, non-resumable failures, and failures older than 7 days;
- then, while above the cap (`min(4 GB, quota / 2)`), evict the oldest failed jobs;
- never evict running jobs.

The extension calls `navigator.storage.persist()` once.

**Not resumable**: direct route (Chrome's own `downloads.resume` is tried first in the same session), capture routes, live streams, and jobs that fall back to memory because OPFS is unavailable.

### 6.7 Errors — `errors.ts`

One table (`ERROR_COPY`) gives each code its message, whether it is retryable, and its primary action (`resume | retry | pick | grant | lower-quality | none`):
`network, expired, drm, too-large, oom, tainted, unsupported, permission, changed, not-found, quota, cancelled, internal`.
`toAppError` maps thrown values: AbortError → cancelled, QuotaExceededError → quota, TypeError → network. `httpError` maps statuses.

### 6.8 Other core helpers

- `filename.ts`
  - Templates: tokens render; empty tokens collapse their separators; unknown tokens stay as written.
  - Sanitiser: strips control and reserved characters and emoji, trims leading and trailing dots, prefixes Windows reserved names (`_CON`), caps at 150 characters, and falls back to `video`.
- `estimate.ts`
  - Downloads: Content-Length × trim fraction, else bitrate × duration.
  - GIF: `w × h × frames × k` (k = 0.55 dithered, 0.35 flat), shown as ±35 %. A working set above 600 MB triggers the low-memory warning.
- `messages.ts`: unions for popup↔SW, SW→popup job events (including `failed{resumable, keptRatio}` and `resume-needs-pick`) and content→SW, plus `isPopupToWorker`.

---

## 7. Remaining build-out (tickets)

| Area | Ticket(s) | Notes |
|---|---|---|
| Scaffold, manifest, icons, tokens, GPL | 01 | Builds on the existing `package.json`/`tsconfig.json` |
| Core library | 02 | **Resolved** by this revision |
| Platform wrappers, messaging runtime, settings store | 03 | `src/platform/*`, ports, `settings.ts` |
| DOM detection | 04 | Fills `VideoSource.dom`, `frameRef`, `protection` |
| Sniffer, registry, generic adapter, adapter interface | 05 | Uses `mergeAll`, `rankSources`, the parsers |
| Popup UI | 06 | Includes the resume banner and "62 % kept" |
| Page picker | 07 | Also serves the resume `pick` fallback |
| Offscreen engine | 08 | ffmpeg.wasm + OPFS store + fetch loop host |
| Download orchestrator | 09 | plan → probe/manifests → tracks → fetch → engine → save |
| Resume wiring | 10 | Startup recovery, banner data, decide → fetch, picker fallback, cleanup alarm |
| Site adapters | 11 Reddit, 12 X, 13 Discord, 19 YouTube (flagged) | |
| Blob/MSE capture | 14 | |
| GIF | 15 | `buildGifArgs`, estimates |
| Frame snap | 16 | |
| Options, history, first run | 17 | |
| Error states and DRM UI | 18 | `ERROR_COPY` |
| Tests, perf, docs, release | 20 | |

UI details (§5 screens and §6 tokens of the source spec) are unchanged from revision 1:
- Paper Ink tokens, a 380 px popup with 20 px padding and 14 px gaps, 44 px targets, visible focus, and reduced-motion support.
- Mockup layouts: single video, list (A), picker (B), and the toggle with its empty state (C).

The tickets restate what each one needs.

---

## 8. Privacy, compliance, store

- No analytics, no remote code, no uploads. Network traffic goes only to the hosts of the media the user chose.
- Permission rationale goes in `docs/store/permissions.md` (ticket 20). `storage` also covers resumable job records, and the store listing says partial media is kept privately on the device for up to 7 days.
- The store build has no YouTube code or strings (CI check). A first-run notice says "Only save content you have the right to use."
- Non-goals: DRM circumvention, bulk/playlist scraping, login automation, cloud storage, and editing beyond trim.

---

## 9. Testing

**In place** (`npm test`, 58 tests, ~1 s):
- `fetch-loop.test.ts`:
  - full download, resume after failure (only the missing bytes are served, all with If-Range), If-Range → `changed`, expired → no retry;
  - 503 backoff sequence, store-over-record reconcile, cancel keeps commits, AES-128 decryption.
- `resume-flow.test.ts`:
  - a 60 MB chunked download where the signature expires after 3 chunks; the record survives JSON plus a "browser restart"; the page is found again on `old.reddit.com#c1` with new signed URLs;
  - matching, continue at 3/8 kept, only 5 chunks fetched, and the assembled file is byte-identical;
  - a changed file → restart; an unknown video → pick.
- `plan.test.ts`: every route/op row in §6.2, plus the ffmpeg and GIF arguments.
- `media.test.ts`: HLS master/media/DRM/IV, DASH base/template/timeline/protection, XML, trim window.
- `misc.test.ts`: filenames, ranking/merge, estimates, URL canonicalisation and matching, validators, chunks, probe, cleanup, message guards.

**To add** (tickets): adapter fixtures (11–13, 19), engine suite against generated clips (08), Playwright e2e and perf budgets (20). The e2e version of the resume scenario: kill the fixture server at 50 %, reload, resume, compare hashes, then repeat after a browser relaunch.

---

## 10. Known limitations

- Stream-copy trims start on a keyframe unless frame-accurate is on.
- ffmpeg.wasm is single-threaded, so 1080p+ transcodes are slower than real time. It also has a ~2 GB heap, so jobs above 1.6 GB that need the engine are refused.
- MediaRecorder captures run in real time. MSE capture only gets what the page buffered and needs site permission before the page loads.
- Frame snap fallback B (`captureVisibleTab`) is screen resolution.
- Resume needs the page to still show the same video. Live streams, captures and small direct downloads can't resume. Partial data is kept for 7 days.
- Multi-period DASH uses only the first period.
- Adapters break when sites change. Fixture tests make that visible.

---

## 11. Task graph and milestones

Exact blockers are the `Blocked by:` lines in each ticket.

```
01 scaffold ─► 03 platform ─┬─► 04 DOM ─────────┬─► 06 popup ─┬─► 15 GIF
(02 core ✓)                  │                   ├─► 07 picker ─┼─► 16 snap
                             ├─► 05 registry ────┤              ├─► 17 options/history
                             │     ├─► 11 reddit, 12 x, 13 discord
                             │     └─► 19 youtube (flag, needs 09)
                             └─► 08 engine ─► 09 orchestrator ─┬─► 10 resume (needs 06, 07)
                                                               ├─► 14 blob/MSE
                                                               ├─► 18 errors/DRM UI
                                                               └─► 20 release (needs all)
```

| Milestone | Tickets | Exit check |
|---|---|---|
| M0 Core | 02 ✓ | `npm test` green, typecheck clean |
| M1 Skeleton | 01, 03 | Loads unpacked, icon shows, messaging round trip |
| M2 Detection | 04, 05, 11, 12, 13 | 3-video fixture listed in < 1 s; adapter fixtures green |
| M3 UI | 06, 07 | Mockups matched; keyboard-only pass |
| M4 Download + resume | 08, 09, 10, 14, 18 | Every §6.2 row works end to end; fail → refresh → resume gives an identical file |
| M5 GIF + snap | 15, 16 | §F3 and §F4 acceptance criteria pass |
| M6 Polish | 17, 19, 20 | Store build clean; docs; perf budgets |
