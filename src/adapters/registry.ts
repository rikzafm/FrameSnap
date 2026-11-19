import type { SiteAdapter } from "./types";
import { genericAdapter } from "./generic";
import { discordAdapter } from "./discord";
import { redditAdapter } from "./reddit";
import { xAdapter } from "./x";
import { youtubeAdapter } from "./youtube";

/** Site-specific adapters go first (tickets 11-13); the generic adapter is the fallback. */
export const ADAPTERS: readonly SiteAdapter[] = [
  discordAdapter,
  redditAdapter,
  xAdapter,
  youtubeAdapter,
  genericAdapter,
];

export function pickAdapter(pageUrl: string): SiteAdapter {
  return ADAPTERS.find((a) => a.matches(pageUrl)) ?? genericAdapter;
}
