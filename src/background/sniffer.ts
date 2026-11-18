/**
 * Network sniffer (observe only). Feeds on webRequest.onHeadersReceived
 * details and keeps one NetworkHit per media URL per tab. Pure: the chrome
 * listener lives in index.ts.
 */
import type { NetworkHit } from "../adapters/types";

export interface ResponseDetails {
  tabId: number;
  frameId: number;
  url: string;
  statusCode: number;
  responseHeaders?: { name: string; value?: string }[];
}

const MEDIA_EXT = /\.(mp4|m4v|webm|m3u8|mpd)$/i;
const MEDIA_TYPE = /^(video\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)|audio\/mpegurl)/i;

export interface Sniffer {
  /** Returns the hit when the URL is new or the response added information; otherwise undefined. */
  observe(d: ResponseDetails): NetworkHit | undefined;
  list(tabId: number): NetworkHit[];
  /** Top-frame navigation clears the tab. */
  navigated(tabId: number, frameId: number): void;
  removed(tabId: number): void;
}

const header = (d: ResponseDetails, name: string) => d.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value;

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/** Total size from "bytes a-b/total". */
function rangeTotal(contentRange: string | undefined): number | undefined {
  const m = /\/(\d+)\s*$/.exec(contentRange ?? "");
  return m ? Number(m[1]) : undefined;
}

export function createSniffer(): Sniffer {
  const tabs = new Map<number, Map<string, NetworkHit>>();

  return {
    observe(d) {
      if (d.tabId < 0 || d.statusCode >= 400) return undefined;
      const contentType = header(d, "content-type")?.split(";")[0]?.trim();
      if (!MEDIA_EXT.test(pathOf(d.url)) && !(contentType && MEDIA_TYPE.test(contentType))) return undefined;

      const total = rangeTotal(header(d, "content-range"));
      const length = header(d, "content-length");
      const contentLength = total ?? (d.statusCode === 206 ? undefined : length !== undefined && /^\d+$/.test(length) ? Number(length) : undefined);
      const ranges = header(d, "accept-ranges");
      const etag = header(d, "etag");
      const fresh: NetworkHit = {
        url: d.url,
        ...(contentType ? { contentType } : {}),
        ...(contentLength !== undefined ? { contentLength } : {}),
        ...(ranges !== undefined || d.statusCode === 206 ? { acceptsRanges: d.statusCode === 206 || /bytes/i.test(ranges ?? "") } : {}),
        ...(etag ? { etag } : {}),
      };

      const hits = tabs.get(d.tabId) ?? new Map<string, NetworkHit>();
      tabs.set(d.tabId, hits);
      const prev = hits.get(d.url);
      if (!prev) {
        hits.set(d.url, fresh);
        return fresh;
      }
      const merged = { ...prev, ...fresh };
      const changed = (Object.keys(merged) as (keyof NetworkHit)[]).some((k) => merged[k] !== prev[k]);
      hits.set(d.url, merged);
      return changed ? merged : undefined;
    },
    list: (tabId) => [...(tabs.get(tabId)?.values() ?? [])],
    navigated(tabId, frameId) {
      if (frameId === 0) tabs.delete(tabId);
    },
    removed: (tabId) => void tabs.delete(tabId),
  };
}
