import { describe, expect, it } from "vitest";
import { discordAdapter } from "../../src/adapters/discord";
import { pickAdapter } from "../../src/adapters/registry";
import type { DetectContext, DomVideo } from "../../src/adapters/types";

const PAGE = "https://discord.com/channels/111222333/444555666";

const dom = (src: string, over: Partial<DomVideo> = {}): DomVideo => ({
  elementKey: "v0",
  frameId: 0,
  src,
  rectWidth: 400,
  rectHeight: 225,
  visibleRatio: 1,
  playing: false,
  ...over,
});

const ctx = (over: Partial<DetectContext> = {}): DetectContext => ({
  pageUrl: PAGE,
  pageTitle: "#general | Discord",
  domVideos: [],
  network: [],
  ...over,
});

const ATT = (ex: string, hm: string) =>
  `https://cdn.discordapp.com/attachments/444555666/987654321/My%20holiday%20clip.mp4?ex=${ex}&is=66aa&hm=${hm}&`;

describe("discord adapter: matching", () => {
  it("matches discord web hosts only, and the registry prefers it", () => {
    expect(discordAdapter.matches("https://discord.com/channels/1/2")).toBe(true);
    expect(discordAdapter.matches("https://ptb.discord.com/channels/1/2")).toBe(true);
    expect(discordAdapter.matches("https://canary.discord.com/channels/1/2")).toBe(true);
    expect(discordAdapter.matches("https://example.org/")).toBe(false);
    expect(pickAdapter("https://discord.com/channels/1/2").site).toBe("discord");
  });
});

describe("discord adapter: attachments", () => {
  it("reports an attachment video with a canonical id that survives ex=/hm= rotation", () => {
    const a = discordAdapter.detect(ctx({ domVideos: [dom(ATT("aaa", "111"))] }));
    const b = discordAdapter.detect(ctx({ domVideos: [dom(ATT("bbb", "222"))] }));
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      id: "discord:444555666/987654321",
      site: "discord",
      title: "My holiday clip",
      pageUrl: PAGE,
      protection: "none",
      detectedBy: ["dom"],
      frameRef: { frameId: 0, elementKey: "v0" },
    });
    expect(a[0]!.variants).toHaveLength(1);
    expect(a[0]!.variants[0]).toMatchObject({ kind: "progressive", container: "mp4", hasAudio: true });
    expect(a[0]!.variants[0]!.url).toContain("ex=aaa");
    expect(b[0]!.id).toBe(a[0]!.id);
    expect(b[0]!.variants[0]!.url).toContain("ex=bbb");
  });

  it("handles media.discordapp.net and webm attachments", () => {
    const url = "https://media.discordapp.net/attachments/1/2/clip.webm?ex=1&hm=2";
    const [s] = discordAdapter.detect(ctx({ domVideos: [dom(url)] }));
    expect(s!.id).toBe("discord:1/2");
    expect(s!.variants[0]!.container).toBe("webm");
  });

  it("picks up sniffed attachment responses and dedupes against the DOM find", () => {
    const hit = { url: ATT("aaa", "111"), contentType: "video/mp4", contentLength: 1234, acceptsRanges: true };
    const both = discordAdapter.detect(ctx({ domVideos: [dom(ATT("aaa", "111"))], network: [hit] }));
    expect(both).toHaveLength(1);
    const net = discordAdapter.detect(ctx({ network: [hit] }));
    expect(net[0]).toMatchObject({ id: "discord:444555666/987654321", detectedBy: ["network"] });
    expect(net[0]!.variants[0]).toMatchObject({ sizeBytes: 1234, acceptsRanges: true });
  });
});

describe("discord adapter: Tenor and Giphy embeds", () => {
  it("reports a Tenor gifv mp4 rendition", () => {
    const [s] = discordAdapter.detect(ctx({ domVideos: [dom("https://media.tenor.com/AbC123xyzAAAPo/happy-dance.mp4")] }));
    expect(s).toMatchObject({ id: "discord:tenor/AbC123xyzAAAPo", site: "discord", title: "happy dance" });
    expect(s!.variants[0]).toMatchObject({ container: "mp4", kind: "progressive" });
  });

  it("unwraps Discord's external media proxy for Tenor", () => {
    const proxied = "https://images-ext-1.discordapp.net/external/sig_AbC/https/media.tenor.com/AbC123xyzAAAPo/happy-dance.mp4";
    const [s] = discordAdapter.detect(ctx({ domVideos: [dom(proxied)] }));
    expect(s!.id).toBe("discord:tenor/AbC123xyzAAAPo");
  });

  it("reports a Giphy embed and falls back to the page title", () => {
    const [s] = discordAdapter.detect(ctx({ domVideos: [dom("https://media2.giphy.com/media/xT9IgzoKnwFNmISR8I/giphy.mp4?cid=1")] }));
    expect(s).toMatchObject({ id: "discord:giphy/xT9IgzoKnwFNmISR8I", title: "#general | Discord" });
    expect(s!.variants[0]!.container).toBe("mp4");
  });
});

describe("discord adapter: no result", () => {
  it("returns nothing for image-only messages, blob: and unrelated videos", () => {
    const found = discordAdapter.detect(
      ctx({
        domVideos: [dom("blob:https://discord.com/abc"), dom("https://example.org/x.mp4")],
        network: [
          { url: "https://cdn.discordapp.com/attachments/1/2/pic.png?ex=1", contentType: "image/png" },
          { url: "https://media.tenor.com/abc/x.gif", contentType: "image/gif" },
        ],
      }),
    );
    expect(found).toEqual([]);
  });
});
