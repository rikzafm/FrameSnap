import { describe, expect, it } from "vitest";
import { installMseHook, type StreamInfo } from "../../src/main-world/mse-hook";
import { createMseClient, createMsePort, MSE_MSG_CHANNEL, type MsePostWindow } from "../../src/main-world/mse-protocol";
import { FakeMediaSource, concatBytes, fakeMseWindow, initSegment, mediaSegment } from "../helpers/fake-mse";

/** One page window shared by the main-world and isolated halves; delivers messages synchronously. */
function pageWindow() {
  const listeners: ((e: MessageEvent) => void)[] = [];
  const win: MsePostWindow & { inject(data: unknown, origin?: string): void } = {
    location: { origin: "https://site.test" },
    addEventListener: (_t, fn) => void listeners.push(fn),
    postMessage(data, origin) {
      for (const l of listeners) l({ data, source: win, origin } as unknown as MessageEvent);
    },
    inject(data, origin = "https://site.test") {
      for (const l of listeners) l({ data, source: {}, origin } as unknown as MessageEvent);
    },
  };
  return win;
}

function setup() {
  const page = pageWindow();
  const mse = fakeMseWindow();
  const ref: { port?: ReturnType<typeof createMsePort> } = {};
  const store = installMseHook(mse as never, { onChange: (s: StreamInfo) => ref.port?.notify(s) });
  ref.port = createMsePort(page, store);
  const ms = new FakeMediaSource();
  const url = mse.URL.createObjectURL(ms);
  const sb = ms.addSourceBuffer('video/mp4; codecs="avc1.64001f, mp4a.40.2"');
  return { page, ms, sb, url, store };
}

describe("MSE bridge", () => {
  it("replays streams that existed before the handshake and follows new ones", () => {
    const { page, sb, url } = setup();
    sb.appendBuffer(initSegment());
    const client = createMseClient(page, "n1");
    let changes = 0;
    client.onChange(() => changes++);
    expect(client.byUrl(url)?.tracks).toHaveLength(1);
    sb.appendBuffer(mediaSegment(1));
    expect(client.byUrl(url)?.bytes).toBe(initSegment().length + mediaSegment(1).length);
    expect(changes).toBeGreaterThan(0);
  });

  it("exports the captured bytes to the isolated side", async () => {
    const { page, sb, url } = setup();
    const client = createMseClient(page, "n1");
    const init = initSegment(3);
    const seg = mediaSegment(9);
    sb.appendBuffer(init);
    sb.appendBuffer(seg);
    const out = await client.export(client.byUrl(url)!.id);
    expect(new Uint8Array(await out!.blob.arrayBuffer())).toEqual(concatBytes(init, seg));
  });

  it("ignores a second handshake and messages without the nonce", async () => {
    const { page, sb, url } = setup();
    const client = createMseClient(page, "n1");
    sb.appendBuffer(initSegment());
    // a page script tries to take over and to ask for data
    page.inject({ channel: "framesnap/mse-init", nonce: "evil" });
    page.inject({ channel: "framesnap/mse-req", nonce: "evil", msg: { t: "export", reqId: 99, id: client.byUrl(url)!.id } });
    page.inject({ channel: MSE_MSG_CHANNEL, nonce: "n1", msg: { t: "stream", info: { id: "fake", tracks: [], bytes: 0, truncated: false } } });
    expect(client.streams().map((s) => s.id)).not.toContain("fake");
    expect((await client.export(client.byUrl(url)!.id))?.container).toBe("mp4");
  });

  it("gives up on an export the page never answers", async () => {
    const page = pageWindow();
    const client = createMseClient(page, "n1", 10);
    expect(await client.export("nope")).toBeUndefined();
  });
});
