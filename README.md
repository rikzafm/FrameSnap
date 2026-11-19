# Frame Snap

A Chrome extension (Manifest V3) that downloads video, makes GIFs and snaps frames. It supports
Reddit, X (Twitter), Discord and YouTube, plus any page with a plain video, and everything runs locally in
your browser. Licensed GPL-3.0-or-later.

- **Video**: pick a quality, format (MP4, WebM, MKV, MOV, MP3, M4A), audio and an optional trim.
  Large files download in chunks and can resume after a failure or a browser restart.
- **GIF**: up to 30 s, with frame rate, width, loop and dither options and a preview before saving.
- **Screenshot**: snap the current frame at video resolution (PNG, JPEG, WebP), step frame by frame,
  burst, or copy to the clipboard. Default shortcut: Alt+Shift+S.

## Requirements

Node.js 22 or newer and a recent Chrome.

```sh
npm install
```

## Load unpacked

1. `npm run build` (writes `dist/`).
2. Open `chrome://extensions`, turn on Developer mode.
3. Choose **Load unpacked** and select the `dist/` folder.
4. Pin the Frame Snap icon, open a page with a video and click the icon.

After a rebuild, press the reload button on the extension card.

## Packaging

`npm run zip` builds and writes `release/frame-snap-<version>.zip`; `npm run store:assets` makes
the store images from the logo into `release/store-assets/`.

## Privacy

- No analytics, no remote code, no uploads. Network traffic goes only to the hosts of the media you
  chose to save.
- Partial downloads are kept privately on your device for up to 7 days so they can resume, then
  deleted. Options has Clear all.
- Permissions and why each is needed: [docs/store/permissions.md](docs/store/permissions.md).
- DRM-protected video is detected and refused.

## Development

```sh
npm run typecheck
npm run lint
npm test              # unit tests (fast)
npm run test:engine   # ffmpeg.wasm against generated clips (slow)
npm run test:browser  # OPFS chunk store in real Chrome
npm run test:e2e      # the built extension in real Chrome (run npm run build first)
```

The e2e suite uses Playwright with the installed Chrome. Chrome ignores `--load-extension`, so the
harness loads the build over the DevTools protocol and grants the fixture host `127.0.0.1` in a
copy of the manifest. It covers detection, download, resume after an expired link, resume after a
browser relaunch, GIF, frame snap, performance budgets and axe-core.

More: [known limitations](docs/known-limitations.md) and the manual checklists in
[docs/testing](docs/testing).
