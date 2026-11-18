import { describe, expect, it } from "vitest";
import { installMseHook } from "../../src/main-world/mse-hook";
import { FakeMediaSource, concatBytes, fakeMseWindow, initSegment, mediaSegment } from "../helpers/fake-mse";

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

function player(maxBytes?: number) {
  const win = fakeMseWindow();
  const store = installMseHook(win as never, maxBytes === undefined ? {} : { maxBytes });
  const ms = new FakeMediaSource();
  const url = win.URL.createObjectURL(ms);
  return { win, store, ms, url };
}

describe("MSE capture", () => {
  it("exports init + media segments in append order as one playable fMP4", async () => {
    const { store, ms, url } = player();
    const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.64001f, mp4a.40.2"');
    const init = initSegment(1);
    const segs = [mediaSegment(1), mediaSegment(2), mediaSegment(3)];
    for (const s of [init, ...segs]) sb.appendBuffer(s);

    const info = store.streams().find((s) => s.url === url)!;
    expect(info.tracks).toHaveLength(1);
    expect(info.tracks[0]).toMatchObject({ kind: "muxed", container: "mp4" });

    const out = store.export(info.id)!;
    expect(out).toMatchObject({ container: "mp4", mime: "video/mp4", hasAudio: true });
    expect(await bytesOf(out.blob)).toEqual(concatBytes(init, ...segs));
  });

  it("copies appended data, so a page reusing its buffer cannot corrupt the capture", async () => {
    const { store, ms } = player();
    const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.64001f"');
    const buf = initSegment(7);
    const keep = buf.slice();
    sb.appendBuffer(buf);
    buf.fill(0);
    expect(await bytesOf(store.export(store.streams()[0]!.id)!.blob)).toEqual(keep);
  });

  it("with separate audio and video buffers exports the video track and says audio is not in it", async () => {
    const { store, ms } = player();
    const v = ms.addSourceBuffer('video/mp4; codecs="avc1.64001f"');
    const a = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    const vi = initSegment(1);
    const vs = mediaSegment(1);
    v.appendBuffer(vi);
    a.appendBuffer(initSegment(2));
    v.appendBuffer(vs);
    a.appendBuffer(mediaSegment(2));
    const info = store.streams()[0]!;
    expect(info.tracks.map((t) => t.kind)).toEqual(["video", "audio"]);
    const out = store.export(info.id)!;
    expect(out.hasAudio).toBe(false);
    expect(await bytesOf(out.blob)).toEqual(concatBytes(vi, vs));
  });

  it("caps memory by dropping the oldest media segments but keeps the init segment", async () => {
    const init = initSegment(1);
    const segs = [1, 2, 3, 4].map((n) => mediaSegment(n));
    const { store, ms } = player(init.length + 2 * segs[0]!.length);
    const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.64001f"');
    sb.appendBuffer(init);
    for (const s of segs) sb.appendBuffer(s);
    const info = store.streams()[0]!;
    expect(info.truncated).toBe(true);
    expect(info.bytes).toBe(init.length + 2 * segs[0]!.length);
    expect(await bytesOf(store.export(info.id)!.blob)).toEqual(concatBytes(init, segs[2]!, segs[3]!));
  });

  it("notifies when a stream appears or grows, and recognises WebM", () => {
    const seen: number[] = [];
    const win = fakeMseWindow();
    const store = installMseHook(win as never, { onChange: (s) => seen.push(s.bytes) });
    const ms = new FakeMediaSource();
    win.URL.createObjectURL(ms);
    const sb = ms.addSourceBuffer('video/webm; codecs="vp9"');
    sb.appendBuffer(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1]));
    expect(seen.length).toBeGreaterThan(0);
    expect(store.streams()[0]!.tracks[0]).toMatchObject({ container: "webm" });
  });

  it("leaves the player's own calls working", () => {
    const { ms } = player();
    const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.64001f"');
    sb.appendBuffer(initSegment());
    expect(sb.appended).toHaveLength(1);
  });
});
