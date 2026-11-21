/**
 * Right-click context menu ("Download with FrameSnap") for videos and GIFs.
 */
import { redditGifOriginal } from "../adapters/reddit";
import { pickAdapter } from "../adapters/registry";
import { fnv1a } from "../core/jobs/chunks";
import { hasGifDownload, isGifImage, type Container, type OutputFormat, type VideoSource } from "../core/model";

export const MENU_TITLE = "Download with FrameSnap";
export const VIDEO_MENU_ID = "frame-snap/download-video";
export const GIF_MENU_ID = "frame-snap/download-gif";
export const GIF_TARGET_PATTERNS = [
  "*://*/*.gif",
  "*://*/*.gif?*",
  "*://*/*.GIF",
  "*://*/*.GIF?*",
  "*://*/*format=gif*",
] as const;

export interface ContextMenusApi {
  create(props: chrome.contextMenus.CreateProperties): Promise<void>;
  removeAll(): Promise<void>;
}

export interface ContextMenuDeps {
  api: ContextMenusApi;
  listSources(tabId: number): Promise<VideoSource[]>;
  refreshSources(tabId: number): Promise<VideoSource[]>;
  getContextTarget(tabId: number, frameId: number): Promise<VideoSource | undefined>;
  startDownload(tabId: number, source: VideoSource, format?: OutputFormat): Promise<void>;
}

export interface ContextMenuService {
  register(): Promise<void>;
  onClicked(
    info: Pick<chrome.contextMenus.OnClickData, "menuItemId" | "srcUrl" | "frameId" | "pageUrl">,
    tab?: Pick<chrome.tabs.Tab, "id" | "url" | "title">,
  ): Promise<void>;
}

const isHttpUrl = (url: string | undefined): url is string => typeof url === "string" && /^https?:/i.test(url);

function gifStem(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    return last.replace(/\.gif$/i, "");
  } catch {
    return "";
  }
}

function containerFromUrl(url: string): Container {
  try {
    if (new URL(url).searchParams.get("format")?.toLowerCase() === "mp4") return "mp4";
  } catch {
    // ignore malformed URLs
  }
  const path = url.split(/[?#]/)[0]!.toLowerCase();
  if (path.endsWith(".mp4") || path.endsWith(".m4v")) return "mp4";
  if (path.endsWith(".webm")) return "webm";
  if (path.endsWith(".ts")) return "ts";
  return "unknown";
}

function resolveVideoSource(
  target: VideoSource | undefined,
  sources: readonly VideoSource[],
  srcUrl: string | undefined,
  frameId: number,
  pageUrl: string,
  pageTitle: string | undefined,
): VideoSource | undefined {
  const httpSrc = isHttpUrl(srcUrl) ? srcUrl : undefined;
  return (
    (target ? sources.find((s) => s.id === target.id && s.variants.length > 0) : undefined) ??
    (target?.frameRef
      ? sources.find(
        (s) => s.frameRef?.frameId === frameId && s.frameRef.elementKey === target.frameRef!.elementKey && s.variants.length > 0,
      )
      : undefined) ??
    (httpSrc ? sources.find((s) => s.variants.some((v) => v.url === httpSrc) || s.gifUrl === httpSrc) : undefined) ??
    (target
      ? sources.find((s) => target.variants.some((tv) => isHttpUrl(tv.url) && s.variants.some((v) => v.url === tv.url)))
      : undefined) ??
    (target && target.variants.length > 0
      ? target.frameRef
        ? { ...target, frameRef: { ...target.frameRef, frameId } }
        : target
      : undefined) ??
    (httpSrc
      ? (() => {
        const gifUrl = redditGifOriginal(httpSrc);
        return {
          id: `dom:${fnv1a(httpSrc)}`,
          site: pickAdapter(pageUrl).site,
          title: pageTitle || "Video",
          pageUrl,
          variants: [
            {
              id: `p:${fnv1a(httpSrc)}`,
              kind: "progressive" as const,
              url: httpSrc,
              container: containerFromUrl(httpSrc),
              hasAudio: !gifUrl,
            },
          ],
          audioTracks: [],
          protection: "none" as const,
          detectedBy: ["dom" as const],
          ...(gifUrl ? { gifUrl, animatedGif: true as const } : {}),
        };
      })()
      : undefined) ??
    sources.find((s) => s.variants.length > 0)
  );
}

export function createContextMenuService(deps: ContextMenuDeps): ContextMenuService {
  return {
    async register() {
      await deps.api.removeAll();
      await deps.api.create({ id: VIDEO_MENU_ID, title: MENU_TITLE, contexts: ["video"] });
      await deps.api.create({
        id: GIF_MENU_ID,
        title: MENU_TITLE,
        contexts: ["image"],
        targetUrlPatterns: [...GIF_TARGET_PATTERNS],
      });
    },

    async onClicked(info, tab) {
      if (!tab || tab.id === undefined) return;
      const tabId = tab.id;
      const pageUrl = tab.url ?? info.pageUrl ?? info.srcUrl ?? "";

      if (info.menuItemId === GIF_MENU_ID) {
        if (!isHttpUrl(info.srcUrl)) return;
        const normalized = redditGifOriginal(info.srcUrl) ?? info.srcUrl;
        const sources = await deps.listSources(tabId).catch(() => [] as VideoSource[]);
        const existing = sources.find(
          (s) => s.variants.some((v) => v.url === normalized || v.url === info.srcUrl) || s.gifUrl === normalized,
        );
        const source: VideoSource = existing ?? {
          id: `gif:${fnv1a(normalized)}`,
          site: pickAdapter(pageUrl).site,
          title: gifStem(normalized) || tab.title || "GIF",
          pageUrl,
          thumbnail: normalized,
          variants: [
            {
              id: `g:${fnv1a(normalized)}`,
              kind: "progressive",
              url: normalized,
              container: "gif",
              hasAudio: false,
            },
          ],
          audioTracks: [],
          protection: "none",
          detectedBy: ["dom"],
        };
        await deps.startDownload(tabId, source, "gif");
        return;
      }

      if (info.menuItemId !== VIDEO_MENU_ID) return;
      const frameId = info.frameId ?? 0;
      const [target, sources] = await Promise.all([
        deps.getContextTarget(tabId, frameId).catch(() => undefined),
        deps.refreshSources(tabId).catch(() => deps.listSources(tabId)),
      ]);
      const source = resolveVideoSource(target, sources, info.srcUrl, frameId, pageUrl, tab.title);
      if (source) {
        const format = isGifImage(source) || hasGifDownload(source) ? "gif" : undefined;
        await deps.startDownload(tabId, source, format);
      }
    },
  };
}
