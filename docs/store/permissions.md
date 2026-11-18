# Permissions

Why the store build asks for each permission. Nothing here is used to send data anywhere: network
requests go only to the hosts of the media the user chose (spec section 8).

## Permissions

- `activeTab`: lets the toolbar popup or the keyboard shortcut act on the page the user is looking at without a broad grant.
- `scripting`: injects the detector into a tab on demand (for example right after the user grants a site) and registers the capture hook for granted sites.
- `downloads`: saves the finished video, GIF or image through Chrome's download manager, and shows it in its folder from History.
- `storage`: keeps settings, the last 20 history entries and per-site memory, and the records of stopped downloads so they can be resumed. Partial media (the bytes already fetched) is kept privately on the device, in the extension's own storage, for up to 7 days and then deleted. Clear all in Options removes it at once.
- `webRequest`: observes (never blocks or changes) response headers of media requests so the popup can list videos a page loads, with their size and range support.
- `offscreen`: runs the converter (ffmpeg compiled to WebAssembly) and the resumable chunk store in a hidden page, because a service worker cannot hold large files or run long encodes.
- `clipboardWrite`: copies a snapped frame to the clipboard when "Copy to clipboard" is on. It is needed because the keyboard shortcut and the timed burst snap without a click in the page, and a browser only lets a page write to the clipboard without one when this permission is granted (ticket 16).
- `alarms`: a daily cleanup that deletes partial downloads older than 7 days and trims storage.
- `declarativeNetRequestWithHostAccess`: adds a temporary session rule that sets the request headers a site needs (such as Referer or Origin) on the requests for a video the user chose, for hosts that refuse a bare request. The rule covers only that video's hosts and is removed when the download ends.

## Hosts and content scripts

- `host_permissions`: the supported sites (Reddit, X/Twitter, Discord) and their media hosts, so detection and downloads work on them from the first visit.
- `optional_host_permissions`: `<all_urls>`, requested one site at a time only when the user turns on "Remember this site" or grants access for a blob or captured video. Options lists every granted site with a Revoke button.
- `content_scripts`: one script on all pages that only looks for `<video>` elements and answers the popup; it does not read page text or send anything on its own. It is declared statically on `<all_urls>` (in every frame, including same-origin iframes) so that a video is already known when the popup opens on any site; the alternative, registering it only for granted sites, would make the first popup on a new site empty (tickets 01 and 04). The X network tap and its bridge run on x.com and twitter.com only.

## Keyboard shortcuts

The `commands` manifest key declares the shortcuts (open the popup, pick a video, snap the frame with Alt+Shift+S). It is a manifest key, not a permission, so it is not in the permission list above.

## Not requested

No `tabs` permission for page contents, no `history`, no `cookies`, no `identity`, no remote code, no analytics.
