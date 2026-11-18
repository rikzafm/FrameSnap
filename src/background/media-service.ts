/**
 * Detection pipeline in the service worker: sniffed responses and DOM scans
 * become VideoSources through the page's adapter, land in the tab registry,
 * and manifests are expanded into variants. Everything chrome-specific is
 * injected.
 */
import { pickAdapter } from "../adapters/registry";
import type { AdapterContext } from "../adapters/types";
import { resumableOn, type JobRecord } from "../core/jobs/job";
import { canonicalPageUrl } from "../core/jobs/source-ref";
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
  /** Saved jobs, for the resume banner. */
  jobs?: { list(): Promise<JobRecord[]> };
}

export interface MediaService {
  onResponse(d: ResponseDetails): Promise<void>;
  onNavigated(tabId: number, frameId: number): Promise<void>;
  onRemoved(tabId: number): Promise<void>;
  /** JSON captured by the page's main-world network tap (`net/tap`); kept per tab and fed to the adapter. */
  onTap(tabId: number, payload: unknown): Promise<void>;
  /** A content script's pushed `dom/report`. The sender's frame id replaces the placeholder in each frameRef. */
  onDomReport(tabId: number, frameId: number, sources: readonly VideoSource[]): Promise<void>;
  /** Cached list first, then a refresh (DOM scan + manifest expansion). */
  openPopup(tabId: number, post: (m: WorkerToPopup) => void): Promise<void>;
}

const MAX_TAPPED = 50;

const unresolved = (s: VideoSource) => s.variants.some((v) => (v.kind === "hls" || v.kind === "dash") && v.live === undefined);

export function createMediaService(deps: MediaServiceDeps): MediaService {
  const { registry, sniffer } = deps;
  /** Tapped payloads per tab, newest last. A tweet page can fire many GraphQL calls. */
  const tapped = new Map<number, unknown[]>();

  const message = (tabId: number, sources: VideoSource[], resumable?: JobRecord[]): WorkerToPopup => ({
    t: "media/updated",
    tabId,
    sources,
    ...(sources[0] ? { selectedId: sources[0].id } : {}),
    ...(resumable ? { resumable } : {}),
  });

  /** Failed jobs the popup can offer to resume on this tab's page. */
  async function resumableFor(tabId: number): Promise<JobRecord[] | undefined> {
    if (!deps.jobs) return undefined;
    try {
      const url = (await deps.getTab(tabId))?.url;
      return url ? resumableOn(await deps.jobs.list(), canonicalPageUrl(url)) : [];
    } catch {
      return undefined;
    }
  }

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
      const finds = pickAdapter(tab.url).detect({
        pageUrl: tab.url,
        pageTitle: tab.title ?? "",
        domVideos: [],
        network: [hit],
        ...(tapped.has(d.tabId) ? { tapped: tapped.get(d.tabId)! } : {}),
      });
      if (finds.length) await registry.ingest(d.tabId, finds);
    },
    async onTap(tabId, payload) {
      const list = [...(tapped.get(tabId) ?? []), payload].slice(-MAX_TAPPED);
      tapped.set(tabId, list);
      const tab = await deps.getTab(tabId);
      if (!tab?.url) return;
      const finds = pickAdapter(tab.url).detect({ pageUrl: tab.url, pageTitle: tab.title ?? "", domVideos: [], network: [], tapped: list });
      if (finds.length) await registry.ingest(tabId, finds);
    },
    async onDomReport(tabId, frameId, sources) {
      if (sources.length === 0) return;
      await registry.ingest(
        tabId,
        sources.map((s) => (s.frameRef ? { ...s, frameRef: { ...s.frameRef, frameId } } : s)),
      );
    },
    async onNavigated(tabId, frameId) {
      sniffer.navigated(tabId, frameId);
      if (frameId === 0) {
        tapped.delete(tabId);
        await registry.clear(tabId);
      }
    },
    async onRemoved(tabId) {
      sniffer.removed(tabId);
      tapped.delete(tabId);
      await registry.clear(tabId);
    },
    async openPopup(tabId, post) {
      const resumable = await resumableFor(tabId);
      post(message(tabId, await registry.list(tabId), resumable));
      const scanned = await deps.scanDom(tabId).catch(() => undefined);
      if (scanned?.length) await registry.ingest(tabId, scanned);
      await resolveAll(tabId, await registry.list(tabId));
      post(message(tabId, await registry.list(tabId), resumable));
    },
  };
}
