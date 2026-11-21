import { describe, expect, it, vi } from "vitest";
import {
  GIF_MENU_ID,
  GIF_TARGET_PATTERNS,
  MENU_TITLE,
  VIDEO_MENU_ID,
  createContextMenuService,
  type ContextMenusApi,
} from "../../src/background/context-menu";
import { handleWorkerMessage } from "../../src/content/handler";
import type { DomDetector } from "../../src/content/dom-detect";
import type { OutputFormat, VideoSource } from "../../src/core/model";

function src(id: string, over: Partial<VideoSource> = {}): VideoSource {
  return {
    id,
    site: "generic",
    title: id,
    pageUrl: "https://example.test/watch",
    variants: [
      {
        id: `v:${id}`,
        kind: "progressive",
        url: `https://cdn.example.test/${id}.mp4`,
        container: "mp4",
        hasAudio: true,
      },
    ],
    audioTracks: [],
    protection: "none",
    detectedBy: ["dom"],
    ...over,
  };
}

function setup(opts: {
  listed?: VideoSource[];
  refreshed?: VideoSource[];
  target?: VideoSource;
} = {}) {
  const created: chrome.contextMenus.CreateProperties[] = [];
  const calls: string[] = [];
  const downloads: { tabId: number; source: VideoSource; format?: OutputFormat }[] = [];

  const api: ContextMenusApi = {
    async removeAll() {
      calls.push("removeAll");
    },
    async create(props) {
      calls.push(`create:${props.id}`);
      created.push(props);
    },
  };

  const service = createContextMenuService({
    api,
    listSources: async () => opts.listed ?? [],
    refreshSources: async () => opts.refreshed ?? opts.listed ?? [],
    getContextTarget: async () => opts.target,
    startDownload: async (tabId, source, format) => {
      downloads.push({ tabId, source, format });
    },
  });

  return { service, created, calls, downloads };
}

describe("context menu service", () => {
  it("registers video and GIF items with 'Download with FrameSnap'", async () => {
    const { service, created, calls } = setup();
    await service.register();

    expect(calls).toEqual(["removeAll", `create:${VIDEO_MENU_ID}`, `create:${GIF_MENU_ID}`]);
    expect(created).toEqual([
      { id: VIDEO_MENU_ID, title: MENU_TITLE, contexts: ["video"] },
      {
        id: GIF_MENU_ID,
        title: MENU_TITLE,
        contexts: ["image"],
        targetUrlPatterns: [...GIF_TARGET_PATTERNS],
      },
    ]);
  });

  describe("GIF clicks", () => {
    it("matches an existing GIF in the registry and downloads as gif", async () => {
      const gifUrl = "https://cdn.example.test/dance.gif";
      const existing = src("gif:1", {
        title: "Happy Dance",
        variants: [{ id: "g:1", kind: "progressive", url: gifUrl, container: "gif", hasAudio: false }],
      });
      const { service, downloads } = setup({ listed: [existing] });

      await service.onClicked({ menuItemId: GIF_MENU_ID, srcUrl: gifUrl, frameId: 0 }, { id: 7, url: "https://example.test/" });

      expect(downloads).toEqual([{ tabId: 7, source: existing, format: "gif" }]);
    });

    it("normalizes Reddit preview GIF URLs to i.redd.it and matches gifUrl", async () => {
      const previewUrl = "https://preview.redd.it/my-title-v0-abc123.gif?format=png8&s=xyz";
      const normalized = "https://i.redd.it/abc123.gif";
      const redditClip = src("reddit:1", {
        site: "reddit",
        gifUrl: normalized,
        animatedGif: true,
        variants: [{ id: "mp4", kind: "progressive", url: "https://preview.redd.it/abc123.gif?format=mp4", container: "mp4", hasAudio: false }],
      });
      const { service, downloads } = setup({ listed: [redditClip] });

      await service.onClicked({ menuItemId: GIF_MENU_ID, srcUrl: previewUrl, frameId: 0 }, { id: 9, url: "https://www.reddit.com/r/gifs/comments/1" });

      expect(downloads).toEqual([{ tabId: 9, source: redditClip, format: "gif" }]);
    });

    it("constructs a direct GIF source when the GIF is not in the registry", async () => {
      const gifUrl = "https://media.example.test/cool%20cat.gif?v=2";
      const { service, downloads } = setup();

      await service.onClicked(
        { menuItemId: GIF_MENU_ID, srcUrl: gifUrl, frameId: 0 },
        { id: 4, url: "https://www.reddit.com/r/aww/comments/1", title: "Page" },
      );

      expect(downloads).toHaveLength(1);
      expect(downloads[0]!.tabId).toBe(4);
      expect(downloads[0]!.format).toBe("gif");
      expect(downloads[0]!.source).toMatchObject({
        site: "reddit",
        title: "cool cat",
        thumbnail: gifUrl,
        variants: [{ kind: "progressive", url: gifUrl, container: "gif", hasAudio: false }],
      });
    });

    it("ignores non-http(s) or missing srcUrl on GIF clicks", async () => {
      const { service, downloads } = setup();
      await service.onClicked({ menuItemId: GIF_MENU_ID, frameId: 0 }, { id: 1 });
      await service.onClicked({ menuItemId: GIF_MENU_ID, srcUrl: "data:image/gif;base64,R0lGOD", frameId: 0 }, { id: 1 });
      expect(downloads).toEqual([]);
    });
  });

  describe("video clicks", () => {
    it("prefers the refreshed registry source matching target id", async () => {
      const target = src("yt:abc", { variants: [{ id: "hls", kind: "hls", url: "https://c.test/m.m3u8", container: "unknown", hasAudio: true }] });
      const resolved = src("yt:abc", {
        variants: [{ id: "1080", kind: "progressive", url: "https://c.test/1080.mp4", container: "mp4", height: 1080, hasAudio: true }],
      });
      const other = src("yt:other");
      const { service, downloads } = setup({ target, refreshed: [other, resolved] });

      await service.onClicked({ menuItemId: VIDEO_MENU_ID, srcUrl: "blob:https://youtube.com/123", frameId: 0 }, { id: 5, url: "https://www.youtube.com/watch?v=abc" });

      expect(downloads).toEqual([{ tabId: 5, source: resolved, format: undefined }]);
    });

    it("matches by frameRef (frameId + elementKey) when target id differs from adapter id", async () => {
      const target = src("dom:local", { frameRef: { frameId: 0, elementKey: "e2" } });
      const registrySource = src("reddit:xyz", { frameRef: { frameId: 3, elementKey: "e2" } });
      const { service, downloads } = setup({ target, refreshed: [registrySource] });

      await service.onClicked({ menuItemId: VIDEO_MENU_ID, srcUrl: "blob:https://reddit.com/1", frameId: 3 }, { id: 6, url: "https://www.reddit.com/" });

      expect(downloads).toEqual([{ tabId: 6, source: registrySource, format: undefined }]);
    });

    it("matches by info.srcUrl when content script returns no target", async () => {
      const wanted = src("s2", { variants: [{ id: "v", kind: "progressive", url: "https://cdn.test/clip2.mp4", container: "mp4", hasAudio: true }] });
      const first = src("s1");
      const { service, downloads } = setup({ target: undefined, refreshed: [first, wanted] });

      await service.onClicked({ menuItemId: VIDEO_MENU_ID, srcUrl: "https://cdn.test/clip2.mp4", frameId: 0 }, { id: 12, url: "https://example.test/" });

      expect(downloads).toEqual([{ tabId: 12, source: wanted, format: undefined }]);
    });

    it("constructs a direct progressive VideoSource from info.srcUrl when registry is empty", async () => {
      const { service, downloads } = setup();

      await service.onClicked(
        { menuItemId: VIDEO_MENU_ID, srcUrl: "https://cdn.example.test/video.webm?token=1", frameId: 0 },
        { id: 8, url: "https://example.test/post", title: "My Clip" },
      );

      expect(downloads).toHaveLength(1);
      expect(downloads[0]!.source).toMatchObject({
        site: "generic",
        title: "My Clip",
        pageUrl: "https://example.test/post",
        variants: [
          {
            kind: "progressive",
            url: "https://cdn.example.test/video.webm?token=1",
            container: "webm",
            hasAudio: true,
          },
        ],
      });
    });

    it("falls back to the first playable registry source when srcUrl is blob: and target is unavailable", async () => {
      const empty = src("empty", { variants: [] });
      const playable = src("yt:main", { site: "youtube" });
      const { service, downloads } = setup({ target: undefined, refreshed: [empty, playable] });

      await service.onClicked(
        { menuItemId: VIDEO_MENU_ID, srcUrl: "blob:https://www.youtube.com/uuid", frameId: 0 },
        { id: 10, url: "https://www.youtube.com/watch?v=1" },
      );

      expect(downloads).toEqual([{ tabId: 10, source: playable, format: undefined }]);
    });

    it("falls back to listSources when refreshSources rejects", async () => {
      const listed = src("cached");
      const downloads: VideoSource[] = [];
      const service = createContextMenuService({
        api: { removeAll: async () => undefined, create: async () => undefined },
        listSources: async () => [listed],
        refreshSources: async () => {
          throw new Error("tab busy");
        },
        getContextTarget: async () => undefined,
        startDownload: async (_tabId, source) => {
          downloads.push(source);
        },
      });

      await service.onClicked({ menuItemId: VIDEO_MENU_ID, srcUrl: "blob:https://example.test/1", frameId: 0 }, { id: 3 });

      expect(downloads).toEqual([listed]);
    });

    it("matches by target variant URL and falls back to target itself with frameId filled in", async () => {
      const target = src("dom:e1", {
        frameRef: { frameId: 0, elementKey: "e1" },
        variants: [{ id: "p:1", kind: "progressive", url: "https://cdn.test/video.mp4", container: "mp4", hasAudio: true }],
      });
      const adapterSource = src("x:1", {
        variants: [{ id: "x:hi", kind: "progressive", url: "https://cdn.test/video.mp4", container: "mp4", hasAudio: true, height: 1080 }],
      });
      const matched = setup({ target, refreshed: [adapterSource] });
      await matched.service.onClicked({ menuItemId: VIDEO_MENU_ID, frameId: 2 }, { id: 11 });
      expect(matched.downloads).toEqual([{ tabId: 11, source: adapterSource, format: undefined }]);

      const directTarget = setup({ target, refreshed: [] });
      await directTarget.service.onClicked({ menuItemId: VIDEO_MENU_ID, frameId: 4 }, { id: 12 });
      expect(directTarget.downloads).toEqual([
        { tabId: 12, source: { ...target, frameRef: { frameId: 4, elementKey: "e1" } }, format: undefined },
      ]);
    });

    it("requests gif format when right-clicking a Reddit preview.redd.it GIF <video>", async () => {
      const mp4Preview = "https://preview.redd.it/my-title-v0-abc123.gif?format=mp4&s=xyz";
      const original = "https://i.redd.it/abc123.gif";
      const fromRegistry = src("dom:gif", {
        site: "reddit",
        gifUrl: original,
        animatedGif: true,
        variants: [{ id: "p:1", kind: "progressive", url: mp4Preview, container: "mp4", hasAudio: false }],
      });
      const reg = setup({ target: fromRegistry, refreshed: [fromRegistry] });
      await reg.service.onClicked(
        { menuItemId: VIDEO_MENU_ID, srcUrl: mp4Preview, frameId: 0 },
        { id: 21, url: "https://www.reddit.com/r/gifs/comments/1" },
      );
      expect(reg.downloads).toEqual([{ tabId: 21, source: fromRegistry, format: "gif" }]);

      const fallback = setup();
      await fallback.service.onClicked(
        { menuItemId: VIDEO_MENU_ID, srcUrl: mp4Preview, frameId: 0 },
        { id: 22, url: "https://www.reddit.com/r/gifs/comments/1", title: "Funny clip" },
      );
      expect(fallback.downloads).toHaveLength(1);
      expect(fallback.downloads[0]!.tabId).toBe(22);
      expect(fallback.downloads[0]!.format).toBe("gif");
      expect(fallback.downloads[0]!.source).toMatchObject({
        site: "reddit",
        gifUrl: original,
        animatedGif: true,
        variants: [{ kind: "progressive", url: mp4Preview, container: "mp4", hasAudio: false }],
      });
    });

    it("requests gif format for animatedGif videos without an original gifUrl", async () => {
      const xGif = src("x:gif", { site: "x", animatedGif: true });
      const { service, downloads } = setup({ target: xGif, refreshed: [xGif] });

      await service.onClicked({ menuItemId: VIDEO_MENU_ID, frameId: 0 }, { id: 23, url: "https://x.com/user/status/1" });

      expect(downloads).toEqual([{ tabId: 23, source: xGif, format: "gif" }]);
    });
  });

  it("ignores unknown menu items or clicks without a tab id", async () => {
    const { service, downloads } = setup({ listed: [src("a")] });
    await service.onClicked({ menuItemId: "other/menu", srcUrl: "https://c.test/a.mp4", frameId: 0 }, { id: 1 });
    await service.onClicked({ menuItemId: VIDEO_MENU_ID, srcUrl: "https://c.test/a.mp4", frameId: 0 }, undefined);
    expect(downloads).toEqual([]);
  });
});

describe("handleWorkerMessage context/target", () => {
  it("replies with context/target-report from the provided lookup", () => {
    const detector = { scan: () => [] } as unknown as DomDetector;
    const expected = src("ctx-1");
    const getContextTarget = vi.fn(() => expected);

    expect(handleWorkerMessage({ t: "context/target" }, detector, "https://example.test", undefined, undefined, getContextTarget)).toEqual({
      t: "context/target-report",
      source: expected,
    });
    expect(handleWorkerMessage({ t: "context/target" }, detector, "https://example.test")).toEqual({
      t: "context/target-report",
      source: undefined,
    });
  });
});
