# 07 — In-page picker overlay and action bar

Status: ready-for-agent
Blocked by: 04
Spec: ../spec.md §6.6 (pick fallback); source §5 mockup B; decision Q6

## What
- Closed-shadow-root overlay with pointer-events none, `elementsFromPoint` hit-testing (incl. shadow DOM), and click capture only while picking.
- Visuals:
  - Ink top bar "Pick a video on this page" with Cancel · Esc;
  - dashed hover outline + "Click to select · W×H";
  - solid accent selected outline + "Selected · W×H";
  - action bar: Download MP4 ▾, GIF, Snap frame.
- Keyboard: Esc, Tab cycles videos, Enter selects. Outlines follow scroll and resize.
- GIF button → `chrome.action.openPopup()` on the GIF tab with that source selected.
- **Resume mode**: `picker/start {resumeJobId}` shows the bar text "Select the video to resume: <title>". The pick is sent as `picker/picked {resumeJobId}`, and the SW checks it with `acceptsPicked`.

## Done when
- E2E: picking each fixture video yields the same source id and options as the list.
- After cancel, page handlers fire normally.
- Resume mode passes the picked source back with its job id.
