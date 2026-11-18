/**
 * Detection pipeline in the service worker: sniffed responses and DOM scans
 * become VideoSources through the page's adapter, land in the tab registry,
 * and manifests are expanded into variants. Everything chrome-specific is
 * injected.
 */
import { pickAdapter } from "../adapters/registry";
import type { AdapterContext } from "../adapters/types";
import type { WorkerToPopup } from "../core/messages";
import type { VideoSource } from "../core/model";
import type { TabRegistry } from "./registry";
import type { ResponseDetails, Sniffer } from "./sniffer";

export interface MediaServiceDeps {
  registry: TabRegistry;
  sniffer: Sniffer;
  getTab(tabId: number): Promise<{ url?: string; title?: string } | undefined>;
  /** Ask the tab's content script for a DOM scan. Undefined when unreachable. */
  scanDom(tabId: number): Promise<VideoSource[] | undefined>;
  adapterContext: AdapterContext;
}

export interface MediaService {
  onResponse(d: ResponseDetails): Promise<void>;
  onNavigated(tabId: number, frameId: number): Promise<void>;
  onRemoved(tabId: number): Promise<void>;
  /** Cached list first, then a refresh (DOM scan + manifest expansion). */
  openPopup(tabId: number, post: (m: WorkerToPopup) => void): Promise<void>;
}

const unresolved = (s: VideoSource) => s.variants.some((v) => (v.kind === "hls" || v.kind === "dash") && v.live === undefined);

export function createMediaService(deps: MediaServiceDeps): MediaService {
  const { registry, sniffer } = deps;

  const message = (tabId: number, sources: VideoSource[]): WorkerToPopup => ({
    t: "media/updated",
    tabId,
    sources,
    ...(sources[0] ? { selectedId: sources[0].id } : {}),
  });

  async function resolveAll(tabId: number, sources: VideoSource[]): Promise<void> {
    for (const s of sources.filter(unresolved)) {
      const resolved = await pickAdapter(s.pageUrl).resolve?.(s, deps.adapterContext);
      if (resolved && resolved !== s) await registry.replaceResolved(tabId, resolved);
    }
  }

  return {
    async onResponse(d) {
      const hit = sniffer.observe(d);
      if (!hit) return;
      const tab = await deps.getTab(d.tabId);
      if (!tab?.url) return;
      const finds = pickAdapter(tab.url).detect({ pageUrl: tab.url, pageTitle: tab.title ?? "", domVideos: [], network: [hit] });
      if (finds.length) await registry.ingest(d.tabId, finds);
    },
    async onNavigated(tabId, frameId) {
      sniffer.navigated(tabId, frameId);
      if (frameId === 0) await registry.clear(tabId);
    },
    async onRemoved(tabId) {
      sniffer.removed(tabId);
      await registry.clear(tabId);
    },
    async openPopup(tabId, post) {
      post(message(tabId, await registry.list(tabId)));
      const scanned = await deps.scanDom(tabId).catch(() => undefined);
      if (scanned?.length) await registry.ingest(tabId, scanned);
      await resolveAll(tabId, await registry.list(tabId));
      post(message(tabId, await registry.list(tabId)));
    },
  };
}
