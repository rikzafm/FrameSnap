/**
 * Known DRM-only services (spec §6.4). Their videos are always listed as protected, even when the
 * page gives no other signal. Detection only: nothing here tries to get around protection.
 */
const DRM_HOSTS = ["netflix.com", "disneyplus.com", "primevideo.com", "max.com", "hbomax.com", "hulu.com", "tv.apple.com", "spotify.com"];

function hostMatches(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

export function isKnownDrmHost(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (DRM_HOSTS.some((h) => hostMatches(host, h))) return true;
  // Prime Video also lives under amazon.* /gp/video
  return /(^|\.)amazon\.[a-z.]+$/.test(host) && /^\/(gp\/video|-\/[a-z]+\/gp\/video)\//.test(u.pathname);
}
