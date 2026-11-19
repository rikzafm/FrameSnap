import { describe, expect, it } from "vitest";
import { foldCaptureDuplicates, rankSources } from "../../src/core/rank";
import type { VideoSource } from "../../src/core/model";

const PAGE = "https://www.youtube.com/watch?v=abc";
const dom = { visibleRatio: 1, rectWidth: 800, rectHeight: 450, playing: true };

const adapter = (over: Partial<VideoSource> = {}): VideoSource => ({
  id: "youtube:abc",
  site: "youtube",
  title: "A talk",
  pageUrl: PAGE,
  duration: 634.6,
  variants: [{ id: "vos:itag:137", kind: "progressive", url: "https://rr1.googlevideo.com/v?itag=137", container: "mp4", height: 1080, hasAudio: false }],
  audioTracks: [],
  protection: "none",
  detectedBy: ["adapter"],
  ...over,
});

const element = (over: Partial<VideoSource> = {}): VideoSource => ({
  id: "dom:1",
  site: "generic",
  title: "A talk - YouTube",
  pageUrl: PAGE,
  duration: 635,
  variants: [{ id: "rec:e1", kind: "recorder", url: "blob:https://www.youtube.com/x", container: "webm", height: 480, hasAudio: true }],
  audioTracks: [],
  protection: "none",
  detectedBy: ["dom"],
  dom,
  frameRef: { frameId: 0, elementKey: "e1" },
  ...over,
});

describe("foldCaptureDuplicates", () => {
  it("gives the adapter find the element's DOM facts and drops the recorder-only entry", () => {
    const out = rankSources([element(), adapter()]);
    expect(out.map((s) => s.id)).toEqual(["youtube:abc"]);
    expect(out[0]!.dom).toEqual(dom);
    expect(out[0]!.frameRef).toEqual({ frameId: 0, elementKey: "e1" });
  });

  it("leaves both when the lengths differ, the page differs, or two adapter finds match", () => {
    expect(foldCaptureDuplicates([element({ duration: 30 }), adapter()])).toHaveLength(2);
    expect(foldCaptureDuplicates([element({ pageUrl: "https://www.youtube.com/watch?v=other" }), adapter()])).toHaveLength(2);
    expect(foldCaptureDuplicates([element(), adapter(), adapter({ id: "youtube:def" })])).toHaveLength(3);
  });

  it("leaves an adapter find that has no variants yet, and an element with a real URL", () => {
    expect(foldCaptureDuplicates([element(), adapter({ variants: [] })])).toHaveLength(2);
    const progressive = element({ variants: [{ id: "u", kind: "progressive", url: "https://cdn/x.mp4", container: "mp4", hasAudio: true }] });
    expect(foldCaptureDuplicates([progressive, adapter()])).toHaveLength(2);
  });
});
