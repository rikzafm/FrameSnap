import { describe, expect, it } from "vitest";
import { createTabRegistry, type SessionArea } from "../../src/background/registry";
import { createMediaService } from "../../src/background/media-service";
import { createSniffer } from "../../src/background/sniffer";
import { requestSiteAccess, originPattern } from "../../src/platform/site-access";
import { parseMaster, parseMedia } from "../../src/core/media/hls";
import { parseMpd } from "../../src/core/media/dash";
import type { VideoSource } from "../../src/core/model";
import type { WorkerToPopup } from "../../src/core/messages";
import * as fx from "../fixtures/hls-page";

function memorySession(): SessionArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    async get(key) {
      return key in data ? { [key]: structuredClone(data[key]) } : {};
    },
    async set(items) {
      Object.assign(data, structuredClone(items));
    },
    async remove(key) {
      delete data[key];
    },
  };
}

const src = (id: string, over: Partial<VideoSource> = {}): VideoSource => ({
  id,
  site: "generic",
  title: id,
  pageUrl: fx.PAGE_URL,
  variants: [{ id: `v-${id}`, kind: "progressive", url: `https://c.test/${id}.mp4`, container: "mp4", hasAudio: true }],
  audioTracks: [],
  protection: "none",
  detectedBy: ["network"],
  ...over,
});

describe("tab registry", () => {
  it("merges finds, orders by rank and mirrors to session storage", async () => {
    const session = memorySession();
    const reg = createTabRegistry(session);
    await reg.ingest(1, [src("small", { dom: { visibleRatio: 1, rectWidth: 100, rectHeight: 100, playing: false }, detectedBy: ["dom"] })]);
    await reg.ingest(1, [src("big", { dom: { visibleRatio: 1, rectWidth: 800, rectHeight: 450, playing: true }, detectedBy: ["dom"] })]);
    await reg.ingest(1, [src("big", { variants: [{ id: "x", kind: "progressive", url: "https://c.test/big.mp4", container: "mp4", hasAudio: true, sizeBytes: 9 }] })]);
    const list = await reg.list(1);
    expect(list.map((s) => s.id)).toEqual(["big", "small"]);
    expect(list[0]!.variants[0]!.sizeBytes).toBe(9);
    expect(Object.keys(session.data)).toEqual(["registry:1"]);
  });

  it("restores from session storage after the service worker restarts", async () => {
    const session = memorySession();
    await createTabRegistry(session).ingest(2, [src("a")]);
    const fresh = createTabRegistry(session); // new SW instance, empty memory
    expect((await fresh.list(2)).map((s) => s.id)).toEqual(["a"]);
  });

  it("clears one tab", async () => {
    const session = memorySession();
    const reg = createTabRegistry(session);
    await reg.ingest(1, [src("a")]);
    await reg.ingest(2, [src("b")]);
    await reg.clear(1);
    expect(await reg.list(1)).toEqual([]);
    expect((await reg.list(2)).map((s) => s.id)).toEqual(["b"]);
    expect(Object.keys(session.data)).toEqual(["registry:2"]);
  });

  it("does not lose concurrent ingests", async () => {
    const reg = createTabRegistry(memorySession());
    await Promise.all([reg.ingest(1, [src("a")]), reg.ingest(1, [src("b")]), reg.ingest(1, [src("c")])]);
    expect((await reg.list(1)).map((s) => s.id).sort()).toEqual(["a", "b", "c"]);
  });
});

function setup(files: Record<string, string>, domReport?: VideoSource[]) {
  const registry = createTabRegistry(memorySession());
  const sniffer = createSniffer();
  const fetched: string[] = [];
  const posted: WorkerToPopup[] = [];
  const service = createMediaService({
    registry,
    sniffer,
    getTab: async () => ({ url: fx.PAGE_URL, title: "Intro clip" }),
    scanDom: async () => domReport,
    adapterContext: {
      fetchText: async (url) => {
        fetched.push(url);
        const t = files[url];
        if (t === undefined) throw new Error("404");
        return t;
      },
      parseMaster,
      parseMedia,
      parseMpd,
    },
  });
  return { registry, sniffer, service, fetched, posted, post: (m: WorkerToPopup) => void posted.push(m) };
}

const hlsResponse = (url: string) => ({ tabId: 5, frameId: 0, url, statusCode: 200, responseHeaders: [{ name: "content-type", value: "application/vnd.apple.mpegurl" }] });

describe("media service", () => {
  const files = { [fx.MASTER_URL]: fx.MASTER, "https://cdn.example.org/hls/720p.m3u8": fx.MEDIA_VOD };

  it("popup open: sends the cached list first, then the refreshed list after DOM scan and manifest expansion", async () => {
    const t = setup(files, []);
    await t.service.onResponse(hlsResponse(fx.MASTER_URL));
    expect(t.fetched).toEqual([]); // the sniffer alone never fetches

    await t.service.openPopup(5, t.post);
    expect(t.posted).toHaveLength(2);
    const [cached, refreshed] = t.posted as Extract<WorkerToPopup, { t: "media/updated" }>[];
    expect(cached!.sources[0]!.variants.map((v) => v.height)).toEqual([undefined]); // placeholder, not yet expanded
    expect(refreshed!.sources[0]!.variants.map((v) => v.height)).toEqual([720, 360]);
    expect(refreshed!.selectedId).toBe(refreshed!.sources[0]!.id);
  });

  it("does not refetch a manifest that is already expanded", async () => {
    const t = setup(files, []);
    await t.service.onResponse(hlsResponse(fx.MASTER_URL));
    await t.service.openPopup(5, t.post);
    const n = t.fetched.length;
    await t.service.openPopup(5, t.post);
    expect(t.fetched.length).toBe(n);
  });

  it("merges the DOM scan into network finds and survives a failing scan", async () => {
    const dom = src("dom1", { detectedBy: ["dom"], dom: { visibleRatio: 1, rectWidth: 640, rectHeight: 360, playing: true } });
    const t = setup(files, [dom]);
    await t.service.openPopup(5, t.post);
    expect((t.posted.at(-1) as { sources: VideoSource[] }).sources.map((s) => s.id)).toEqual(["dom1"]);

    const broken = setup(files);
    await broken.service.openPopup(5, broken.post);
    expect(broken.posted).toHaveLength(2);
  });

  it("clears the registry on top-frame navigation", async () => {
    const t = setup(files, []);
    await t.service.onResponse(hlsResponse(fx.MASTER_URL));
    await t.service.onNavigated(5, 0);
    expect(await t.registry.list(5)).toEqual([]);
    expect(t.sniffer.list(5)).toEqual([]);
  });

  it("marks DRM manifests", async () => {
    const t = setup({ [fx.MASTER_URL]: fx.MASTER, "https://cdn.example.org/hls/720p.m3u8": fx.MEDIA_DRM }, []);
    await t.service.onResponse(hlsResponse(fx.MASTER_URL));
    await t.service.openPopup(5, t.post);
    expect((t.posted.at(-1) as { sources: VideoSource[] }).sources[0]!.protection).toBe("drm");
  });
});

describe("site access for unlisted sites", () => {
  it("builds an origin pattern", () => {
    expect(originPattern("https://videos.example.org/watch/42?x=1")).toBe("https://videos.example.org/*");
    expect(originPattern("chrome://extensions")).toBeUndefined();
  });

  it("asks once, injects the content script when granted, and skips when already allowed", async () => {
    const calls: string[] = [];
    const mk = (has: boolean, grant: boolean) => ({
      permissions: {
        contains: async () => has,
        request: async () => {
          calls.push("request");
          return grant;
        },
      },
      injectContent: async (tabId: number) => void calls.push(`inject:${tabId}`),
    });
    expect(await requestSiteAccess(3, fx.PAGE_URL, mk(true, false))).toBe("already");
    expect(calls).toEqual([]);
    expect(await requestSiteAccess(3, fx.PAGE_URL, mk(false, true))).toBe("granted");
    expect(calls).toEqual(["request", "inject:3"]);
    calls.length = 0;
    expect(await requestSiteAccess(3, fx.PAGE_URL, mk(false, false))).toBe("denied");
    expect(calls).toEqual(["request"]);
    expect(await requestSiteAccess(3, "chrome://extensions", mk(false, true))).toBe("unsupported");
  });
});
