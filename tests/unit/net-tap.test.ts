import { describe, expect, it, vi } from "vitest";
import { createTapReceiver, TAP_CHANNEL } from "../../src/main-world/protocol";
import { installNetTap, isGraphqlUrl } from "../../src/main-world/net-tap";

const evt = (data: unknown, source: unknown = "win", origin = "https://x.com") =>
  ({ data, source, origin }) as MessageEvent;

describe("tap receiver", () => {
  const make = () => {
    const got: unknown[] = [];
    const rx = createTapReceiver({ nonce: "n1", window: "win", origin: "https://x.com", onPayload: (p) => got.push(p) });
    return { got, rx };
  };

  it("accepts a message carrying the nonce", () => {
    const { got, rx } = make();
    rx(evt({ channel: TAP_CHANNEL, nonce: "n1", payload: { a: 1 } }));
    expect(got).toEqual([{ a: 1 }]);
  });

  it.each([
    ["wrong nonce", evt({ channel: TAP_CHANNEL, nonce: "bad", payload: 1 })],
    ["wrong channel", evt({ channel: "other", nonce: "n1", payload: 1 })],
    ["foreign window", evt({ channel: TAP_CHANNEL, nonce: "n1", payload: 1 }, "other")],
    ["foreign origin", evt({ channel: TAP_CHANNEL, nonce: "n1", payload: 1 }, "win", "https://evil.com")],
    ["non-object", evt("hi")],
  ])("drops %s", (_n, e) => {
    const { got, rx } = make();
    rx(e);
    expect(got).toEqual([]);
  });
});

describe("graphql url filter", () => {
  it("accepts X graphql endpoints only", () => {
    expect(isGraphqlUrl("https://x.com/i/api/graphql/abc/TweetDetail?v=1")).toBe(true);
    expect(isGraphqlUrl("https://twitter.com/i/api/graphql/abc/HomeTimeline")).toBe(true);
    expect(isGraphqlUrl("https://x.com/i/api/2/other.json")).toBe(false);
  });
});

function fakeWindow(fetchImpl: () => Promise<Response>) {
  const posted: unknown[] = [];
  const win = {
    fetch: vi.fn(fetchImpl),
    postMessage: (m: unknown) => posted.push(m),
    location: { origin: "https://x.com" },
  } as unknown as Window & typeof globalThis;
  return { win, posted };
}

describe("fetch tap", () => {
  it("posts parsed JSON of graphql responses and leaves the response readable", async () => {
    const body = JSON.stringify({ data: { ok: true } });
    const { win, posted } = fakeWindow(async () => new Response(body));
    installNetTap(win, "n1");
    const res = await win.fetch("https://x.com/i/api/graphql/h/TweetDetail");
    expect(await res.json()).toEqual({ data: { ok: true } });
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toEqual([{ channel: TAP_CHANNEL, nonce: "n1", payload: { data: { ok: true } } }]);
  });

  it("ignores non-graphql fetches", async () => {
    const { win, posted } = fakeWindow(async () => new Response("{}"));
    installNetTap(win, "n1");
    await win.fetch("https://x.com/other");
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toEqual([]);
  });

  it("does not break the page when the body is not JSON", async () => {
    const { win, posted } = fakeWindow(async () => new Response("<html>"));
    installNetTap(win, "n1");
    const res = await win.fetch("https://x.com/i/api/graphql/h/TweetDetail");
    expect(await res.text()).toBe("<html>");
    await new Promise((r) => setTimeout(r, 0));
    expect(posted).toEqual([]);
  });
});
