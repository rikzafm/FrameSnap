# Manual checklist: Discord adapter

Run against discord.com (web) in a channel you control, with the built extension loaded.

## Setup

- [ ] Post a message with an mp4 attachment, one with a webm attachment, and one with an image only.
- [ ] Post a Tenor link and a Giphy link so they render as embedded gifv/video.

## Attachments

- [ ] The mp4 attachment shows up in the popup with a title from its file name.
- [ ] Download works; the saved file plays and matches the attachment.
- [ ] The webm attachment is listed and downloads.
- [ ] The image-only message produces no entry.

## Embeds

- [ ] The Tenor embed is listed with an mp4 rendition and downloads.
- [ ] The Giphy embed is listed with an mp4 rendition and downloads.
- [ ] The GIF export path works on a Tenor/Giphy find.

## Resume after URL rotation

- [ ] Start a large attachment download and pause or interrupt it (for example, go offline).
- [ ] Wait until the signed `ex=` timestamp has passed, or reload the channel so Discord issues a new signed URL (`ex=`/`hm=` change).
- [ ] Resume the download. It continues from the saved offset under the same source id (`discord:<channel>/<attachment id>`) rather than restarting as a new item.
- [ ] The final file plays and has the expected size.

## Other hosts

- [ ] `ptb.discord.com` and `canary.discord.com` behave the same as discord.com.
- [ ] A normal non-Discord page still uses the generic adapter.
