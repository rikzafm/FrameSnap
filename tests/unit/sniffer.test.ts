import { describe, expect, it } from "vitest";
import { createSniffer, type ResponseDetails } from "../../src/background/sniffer";

const resp = (url: string, headers: Record<string, string> = {}, over: Partial<ResponseDetails> = {}): ResponseDetails => ({
  tabId: 7,
  frameId: 0,
  url,
  statusCode: 200,
  responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
  ...over,
});

describe("network sniffer", () => {
  it("records media URLs by extension with length, ranges and etag", () => {
    const s = createSniffer();
    const hit = s.observe(resp("https://cdn.test/v/a.mp4?sig=1", { "Content-Length": "5000", "accept-ranges": "bytes", ETag: '"abc"' }));
    expect(hit).toEqual({ url: "https://cdn.test/v/a.mp4?sig=1", contentLength: 5000, acceptsRanges: true, etag: '"abc"' });
    expect(s.list(7)).toEqual([hit]);
  });

  it("recognises manifests and media content types without a telling extension", () => {
    const s = createSniffer();
    expect(s.observe(resp("https://x.test/stream/1", { "content-type": "application/vnd.apple.mpegurl" }))).toBeDefined();
    expect(s.observe(resp("https://x.test/stream/2", { "content-type": "application/dash+xml" }))).toBeDefined();
    expect(s.observe(resp("https://x.test/blob/3", { "content-type": "video/webm; codecs=vp9" }))).toBeDefined();
    expect(s.observe(resp("https://x.test/a.webm"))).toBeDefined();
    expect(s.observe(resp("https://x.test/a.mpd"))).toBeDefined();
    expect(s.list(7)).toHaveLength(5);
  });

  it("ignores non-media, failed, and tab-less responses", () => {
    const s = createSniffer();
    expect(s.observe(resp("https://x.test/app.js", { "content-type": "text/javascript" }))).toBeUndefined();
    expect(s.observe(resp("https://x.test/a.mp4", {}, { statusCode: 404 }))).toBeUndefined();
    expect(s.observe(resp("https://x.test/a.mp4", {}, { tabId: -1 }))).toBeUndefined();
    expect(s.list(7)).toEqual([]);
  });

  it("collapses range requests for one URL into a single entry with the full size", () => {
    const s = createSniffer();
    s.observe(resp("https://cdn.test/a.mp4", { "content-range": "bytes 0-999/5000", "content-length": "1000", "accept-ranges": "bytes" }, { statusCode: 206 }));
    s.observe(resp("https://cdn.test/a.mp4", { "content-range": "bytes 1000-1999/5000", "content-length": "1000" }, { statusCode: 206 }));
    expect(s.list(7)).toEqual([{ url: "https://cdn.test/a.mp4", contentLength: 5000, acceptsRanges: true }]);
  });

  it("returns a hit only when it is new or adds information", () => {
    const s = createSniffer();
    expect(s.observe(resp("https://cdn.test/a.mp4", { "content-length": "10" }))).toBeDefined();
    expect(s.observe(resp("https://cdn.test/a.mp4", { "content-length": "10" }))).toBeUndefined();
  });

  it("keeps tabs apart and clears on top-frame navigation only", () => {
    const s = createSniffer();
    s.observe(resp("https://cdn.test/a.mp4"));
    s.observe(resp("https://cdn.test/b.mp4", {}, { tabId: 8 }));
    s.navigated(7, 3); // sub-frame: keep
    expect(s.list(7)).toHaveLength(1);
    s.navigated(7, 0);
    expect(s.list(7)).toEqual([]);
    expect(s.list(8)).toHaveLength(1);
    s.removed(8);
    expect(s.list(8)).toEqual([]);
  });
});
