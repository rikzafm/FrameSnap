# 13 — Discord adapter (attachments, Tenor, Giphy)

Status: ready-for-agent
Blocked by: 05
Spec: source §F6

## What
- Attachments on cdn.discordapp.com / media.discordapp.net: progressive, with signed `ex=`/`hm=` URLs. Canonical id `discord:<channel>/<attachment id>`, so resume survives URL rotation.
- Tenor/Giphy embeds → the best mp4/webm rendition; title from the embed or alt text.

## Done when
- Fixture tests: attachment video, Tenor gifv, Giphy embed, image-only message (no result).
- Manual checklist `docs/testing/manual-discord.md` passes, including resume after the `ex=` URL rotates.
