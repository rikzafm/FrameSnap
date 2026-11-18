# Known limitations

From spec section 10, plus what real-browser testing added.

- **Trims** made by stream copy start on a keyframe, so the start can be a little early. Turn on frame-accurate trim to re-encode for an exact cut.
- **ffmpeg.wasm is single-threaded**, so transcodes of 1080p and up run slower than real time. It also has a heap of about 2 GB, so a job that needs the engine and is above 1.6 GB is refused with a message.
- **Captures** (blob and MSE videos) are limited. A MediaRecorder capture runs in real time and the video has to be playing. An MSE capture only gets what the page has buffered, and it needs the site's permission granted before the page loads.
- **Frame snap fallback B** (`captureVisibleTab`) is at screen resolution, not video resolution. It is used only when the page video is cross-origin and has no CORS headers.
- **Resume** needs the page to still show the same video, found by id or by site, duration and a single match. Live streams, captures and small direct downloads cannot resume. Partial data is kept for 7 days.
- **Multi-period DASH** uses only the first period.
- **Adapters break** when sites change their pages or APIs. The fixture tests make that visible, but a fix is still needed.
- **Generic pages with signed URLs and no duration** cannot be matched on resume by themselves; the popup asks the user to pick the video again.
- **YouTube** exists only in the personal build, and videos that only offer ciphered formats yield no sources.
- **DRM** (Widevine and similar) is detected and refused; circumventing it is a non-goal.
- **The first page opened right after installing** may not be seen by the network observer (it starts with the service worker). Reload the page once.
- **The keyboard shortcut** is not delivered to automated browsers, so that path is covered by unit tests and the manual checklists, not by the e2e suite.
