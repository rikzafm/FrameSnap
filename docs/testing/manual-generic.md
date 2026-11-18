# Manual checklist: generic pages, picker, blob and MSE videos

Build with `npm run build`, load `dist/` unpacked. Use any site that is not Reddit, X or Discord.

## Detection and popup
- [ ] Open a page with a plain `<video src>` (mp4). The popup lists it in under a second, with size and duration.
- [ ] Open a page with two videos. Both are listed and the playing or on-screen one is first.
- [ ] A page with no video shows the empty state with "Start picking".
- [ ] The popup works with the keyboard only (Tab order, visible focus, Enter and Space on buttons).
- [ ] Dark and light themes both look right; the popup is 380 px wide and has no horizontal scroll.

## Picker
- [ ] Start picking: hover shows an outline, a click picks the video, Escape cancels.
- [ ] Picking a video inside an iframe works (grant the site if asked).

## Direct and chunked downloads
- [ ] A direct mp4 under 50 MB downloads and plays.
- [ ] A direct mp4 over 50 MB with range support shows progress, can be cancelled and is listed in History.
- [ ] Turn the network off mid download: the popup offers Resume, and after reconnecting it finishes with a playable file.
- [ ] Close Chrome mid download, reopen, open the page: the banner offers Resume.

## Blob and MSE videos
- [ ] On a site that plays through MSE, grant the site, reload, play. The popup lists a capture variant with a warning that it is real time or only what is buffered.
- [ ] The captured file plays for the buffered range.
- [ ] A DRM video shows the protected-content notice and no download button.

## GIF and snap
- [ ] GIF tab: a 5 s range at 480 px and 15 fps makes a preview in a few seconds, Save and Discard work, and the page stays responsive meanwhile.
- [ ] Screenshot tab: Snap saves a PNG at the video's resolution; the step buttons move one frame; burst saves frames at the chosen interval.
- [ ] The keyboard shortcut (default Alt+Shift+S) snaps the frame while the video keeps playing and shows a toast.
- [ ] A cross-origin video without CORS falls back to the visible-tab capture and says so.

## Options and privacy
- [ ] First install opens Options with the use notice; the popup shows "Only save content you have the right to use" until Got it.
- [ ] Sites lists granted origins and Revoke removes access; Clear all removes history and partial downloads, with Undo for 8 seconds.
- [ ] The DevTools network tab shows requests only to the video's own hosts.
