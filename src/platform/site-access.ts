/**
 * Host-permission flow for sites outside the manifest's built-in list.
 * chrome.permissions.request needs a user gesture, so this runs from the
 * popup click handler.
 */
export function originPattern(pageUrl: string): string | undefined {
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return `${u.protocol}//${u.host}/*`;
  } catch {
    return undefined;
  }
}

export interface SiteAccessDeps {
  permissions: {
    contains(p: { origins: string[] }): Promise<boolean>;
    request(p: { origins: string[] }): Promise<boolean>;
  };
  /** Run the content script in a tab that was already open when access was granted. */
  injectContent(tabId: number): Promise<void>;
}

export type SiteAccessResult = "already" | "granted" | "denied" | "unsupported";

export async function requestSiteAccess(tabId: number, pageUrl: string, deps: SiteAccessDeps): Promise<SiteAccessResult> {
  const origin = originPattern(pageUrl);
  if (!origin) return "unsupported";
  const perm = { origins: [origin] };
  if (await deps.permissions.contains(perm)) return "already";
  if (!(await deps.permissions.request(perm))) return "denied";
  await deps.injectContent(tabId);
  return "granted";
}

export interface SiteListDeps {
  permissions: {
    getAll(): Promise<{ origins?: string[] }>;
    remove(p: { origins: string[] }): Promise<boolean>;
  };
}

/** Origins the user granted at runtime (everything beyond the manifest's built-in hosts). */
export async function grantedSites(deps: SiteListDeps, builtIn: readonly string[]): Promise<string[]> {
  const all = (await deps.permissions.getAll()).origins ?? [];
  return all.filter((o) => !builtIn.includes(o));
}

export function revokeSiteAccess(origin: string, deps: SiteListDeps): Promise<boolean> {
  return deps.permissions.remove({ origins: [origin] });
}
