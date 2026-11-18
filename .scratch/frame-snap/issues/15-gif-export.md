# 15 — GIF tab and export

Status: ready-for-agent
Blocked by: 06, 08, 09
Spec: ../spec.md §6.3, §6.8; source §F3

## What
- GIF tab:
  - preview and frame strip with two trim handles (`role="slider"`, keyboard steps); defaults: start = currentTime, 2.0 s, max `GIF_MAX_SECONDS`;
  - chips: fps 10/15/24/30, width 320/480/640/Original, loop (∞/1/2/3), dither;
  - live `estimateGifBytes` range, and a low-memory warning when `gifWorkingSetBytes > GIF_LOW_MEMORY_BYTES`.
- Job: fetch the range with the download pipeline (stream-copy trim; reuses the chunk store, so a retry doesn't refetch) → `buildGifArgs` two passes → preview with Save/Discard. The result survives the popup closing.
- Picker GIF button → popup on the GIF tab (07).

## Done when
- E2E: a 5 s, 480 px, 15 fps GIF is produced with no page long task > 200 ms, and the popup stays interactive.
- The estimator is within ±35 % on the test corpus; recalibrate `GIF_BYTES_PER_PIXEL` if not.
