import type { SiteAdapter } from "./types";
import { genericAdapter } from "./generic";
import { redditAdapter } from "./reddit";

/** Site-specific adapters go first (tickets 11-13); the generic adapter is the fallback. */
export const ADAPTERS: readonly SiteAdapter[] = [redditAdapter, genericAdapter];

export function pickAdapter(pageUrl: string): SiteAdapter {
  return ADAPTERS.find((a) => a.matches(pageUrl)) ?? genericAdapter;
}
