# 01 — Scaffold, manifest, icons, design tokens, GPL licence

Status: resolved
Blocked by: none
Spec: ../spec.md §1 (Q1, Q2, Q4), §2, §3

## What
- Add Vite + `@crxjs/vite-plugin` on top of the existing `package.json` / `tsconfig.json`; ESLint + Prettier.
- `src/manifest.ts`:
  - permissions: `activeTab, scripting, downloads, storage, webRequest, offscreen, clipboardWrite, commands, alarms, declarativeNetRequestWithHostAccess`;
  - host permissions for the supported sites; `optional_host_permissions: ["<all_urls>"]`;
  - commands `_execute_action`, `start-picker`, `snap-frame` (Alt+Shift+S);
  - CSP `script-src 'self' 'wasm-unsafe-eval'`.
- `__YOUTUBE__` define: `build` (store, false) and `build:personal` (true).
- `scripts/build-icons.ts` (`@resvg/resvg-js`): `assets/logo/*.svg` → `public/icons/icon-{16,32,48,128}.png`.
- `src/ui/tokens.css` + `base.css` (Paper Ink tokens, focus ring, reduced motion); local Fraunces/Inter woff2.
- Empty entries for the SW, content script, popup, options and offscreen pages.
- Replace `LICENSE` with GPL-3.0 and set `"license": "GPL-3.0-or-later"`.

## Done when
- `npm run build` → `dist/` loads unpacked with no errors, and the toolbar icon matches the logo at 16 and 32 px.
- The popup shows the header (logo + "Frame Snap" in Fraunces) at 380 px.
- `npm run lint`, `npm run typecheck` and `npm test` pass; existing core tests are unaffected.

## Answer

Scaffold is in place: Vite 7 + `@crxjs/vite-plugin` 2, ESLint (flat config) + Prettier, GPL-3.0 `LICENSE`, `"license": "GPL-3.0-or-later"`.

- Manifest: `src/manifest.ts` exports `buildManifest({ youtube })`, a pure function (unit-tested in `tests/unit/manifest.test.ts`); `vite.config.ts` wraps it with `defineManifest`. Host permissions cover Reddit, X/Twitter and Discord; YouTube/googlevideo hosts are added only when `youtube` is true.
- Builds: `npm run build` (store, `__YOUTUBE__` = false, `dist/`) and `npm run build:personal` (`--mode personal`, `__YOUTUBE__` = true, `dist-personal/`). `__YOUTUBE__` is declared in `src/env.d.ts`.
- Icons: `scripts/build-icons.ts` (`@resvg/resvg-js`) renders `assets/logo/*.svg` to `public/icons/icon-{16,32,48,128}.png` (the 16 px size uses the hinted master); `npm run icons`, run by both build scripts.
- UI: `src/ui/tokens.css` (Paper Ink light + derived dark, selected by `data-theme` or `prefers-color-scheme`) and `base.css` (focus ring, 44 px targets, reduced motion). Fraunces 600 and Inter 400/500/600 woff2 files are in `src/ui/fonts/`. The popup is 380 px wide with the logo + "Frame Snap" header.
- Empty entries: `src/background/index.ts`, `src/content/index.ts`, `src/popup/`, `src/options/`, `src/offscreen/` (offscreen page added as an extra Rollup input).
- Tooling notes: existing `src/core`, `src/offscreen/opfs-chunk-store.ts` and old tests are excluded from Prettier (kept in their own style); ESLint relaxes `no-control-regex` / `no-irregular-whitespace` for `filename.ts` and `hls.ts`, where they are intentional.
- Not verified: loading `dist/` unpacked in Chrome and viewing the toolbar icon / popup in a real browser (build and unit checks pass only).
- Open: the dark palette values and the `_execute_action` shortcut (none set) are placeholders for owner sign-off; no `map.md` exists to append a pointer to.
