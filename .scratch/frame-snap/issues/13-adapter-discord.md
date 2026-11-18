# 13 — Discord adapter (attachments, Tenor, Giphy)

Status: resolved
Blocked by: 05
Spec: source §F6

## What
- Attachments on cdn.discordapp.com / media.discordapp.net: progressive, with signed `ex=`/`hm=` URLs. Canonical id `discord:<channel>/<attachment id>`, so resume survives URL rotation.
- Tenor/Giphy embeds → the best mp4/webm rendition; title from the embed or alt text.

## Done when
- Fixture tests: attachment video, Tenor gifv, Giphy embed, image-only message (no result).
- Manual checklist `docs/testing/manual-discord.md` passes, including resume after the `ex=` URL rotates.

## Answer

Added `src/adapters/discord.ts` (`discordAdapter`, registered ahead of the generic adapter in `src/adapters/registry.ts`). It matches discord.com, ptb. and canary. hosts and reads DOM videos and sniffed network hits.

- Attachments on cdn.discordapp.com / media.discordapp.net get the canonical id `discord:<channel>/<attachment id>`, so the id is unchanged when the signed `ex=`/`is=`/`hm=` URL rotates. Title comes from the file name.
- Tenor and Giphy mp4/webm renditions (including Discord's `/external/<sig>/https/<host>/...` proxy form) get `discord:tenor/<id>` and `discord:giphy/<id>`. The title is the URL slug when there is one, otherwise the page title. DomVideo carries no alt text, so alt-text titles are not available.
- Image-only messages, blob: sources, non-video extensions and unrelated hosts yield no result.

Tests: `tests/unit/discord-adapter.test.ts` (attachment, rotation, webm, network dedupe, Tenor, Tenor proxy, Giphy, image-only). Manual checklist: `docs/testing/manual-discord.md` (not run by the agent).
