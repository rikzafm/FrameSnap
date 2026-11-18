# 01 — Scaffold, manifest, icons, design tokens, GPL licence

Status: ready-for-agent
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
