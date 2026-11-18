# Manual checklist: X (Twitter) adapter

Build with `npm run build`, load `dist/` unpacked, and open x.com signed in or out. Open the
extension service worker console and the page console to watch for errors.

## Network tap
- [ ] Reload x.com. The page behaves normally (timeline loads, no console errors from `net-tap`).
- [ ] In the page console, `fetch("https://x.com/i/api/graphql/x/y")` still returns a normal response.
- [ ] Posting `window.postMessage({channel:"framesnap/net-tap",nonce:"guess",payload:{}}, "*")` from the page console is ignored (no source appears in the popup).

## Detection
- [ ] Open a tweet with a video (`/user/status/<id>`). The popup lists it with several mp4 qualities, highest first.
- [ ] Sizes appear for qualities the sniffer has seen; HLS appears as the last variant.
- [ ] Scroll a timeline with two or more videos. Each shows up once, and the on-screen video ranks first.
- [ ] A GIF tweet is listed as a single mp4 with no audio.
- [ ] A tweet whose video only offers HLS lists one HLS variant and downloads.
- [ ] Same checks on twitter.com (old links) and on a quote tweet or reply thread.
- [ ] Source ids follow `x:<tweet id>:<media key>`; reloading the page keeps the same id.

## Download
- [ ] Download the highest mp4: the file plays and the filename uses the tweet text.
- [ ] Download via the HLS fallback: the file plays with audio.
