# 18 — Error states and DRM UI

Status: ready-for-agent
Blocked by: 09
Spec: ../spec.md §6.4 (DRM signals), §6.7; source §7

## What
- Merge DRM signals from DOM (`mediaKeys`), HLS/DASH parsers and a known-DRM host list (Netflix, Disney+, Prime Video, Max, Hulu, Apple TV+, Spotify). Such videos are listed with every action disabled and "This video is protected and cannot be saved". Never attempt a bypass.
- Render every `ErrorCode` from `ERROR_COPY` with its action button: resume / retry / pick / grant / lower-quality. Used in the popup, the picker bar and toasts.
- Warnings: `large-file` (> 500 MB), `too-large` (blocks engine jobs > 1.6 GB, suggests a lower quality or trim), and the GIF low-memory warning.

## Done when
- The fake-EME fixture shows the protected state with no enabled action.
- Each error code renders its copy and action (component test).
