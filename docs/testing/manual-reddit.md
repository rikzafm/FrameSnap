# Manual checklist: Reddit

Load the built extension (`dist/`) in Chrome. Use a logged-out and a logged-in profile if possible.

## Download has audio

1. Open a post with a video that has sound (new layout, `www.reddit.com`). Open the popup: the post appears with its title and a quality list.
2. Download as MP4 at the best quality. Open the file: video plays **and has audio**.
3. Repeat on `old.reddit.com` with another video post.
4. Repeat on a comment that contains a video, and on a feed (subreddit listing) with two video posts: each appears as its own item.
5. Open a video post with no audio track (a silent GIF-style clip). It downloads, plays silently, and no audio error is shown.
6. Download "audio only" on a post with sound: the file is M4A with sound.

## Resume after a refresh

1. Start a download of a long Reddit video, then interrupt it (disable network or kill the service worker from `chrome://serviceworker-internals`).
2. Refresh the page (or open the same post via `old.reddit.com`).
3. The popup offers to resume the failed job for the same post, and resuming completes a MP4 that has audio.
