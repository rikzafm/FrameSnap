import { describe, expect, it } from "vitest";
import { routePopupMessage } from "../../src/background/router";

describe("routePopupMessage", () => {
  it("relays a demo ping to the tab's content script and returns its pong", async () => {
    const sent: unknown[] = [];
    const reply = await routePopupMessage(
      { t: "demo/ping", tabId: 7, nonce: "n1" },
      {
        sendToTab: async (tabId, m) => {
          sent.push([tabId, m]);
          return { t: "demo/pong", nonce: "n1", reply: "content-ok" };
        },
      },
    );
    expect(sent).toEqual([[7, { t: "demo/ping", nonce: "n1" }]]);
    expect(reply).toEqual({ t: "demo/pong", nonce: "n1", reply: "content-ok" });
  });

  it("rejects a malformed content reply", async () => {
    const reply = await routePopupMessage({ t: "demo/ping", tabId: 7, nonce: "n1" }, { sendToTab: async () => ({ junk: true }) });
    expect(reply).toBeUndefined();
  });

  it("ignores messages that are not yet handled", async () => {
    const reply = await routePopupMessage({ t: "media/list", tabId: 1 }, { sendToTab: async () => undefined });
    expect(reply).toBeUndefined();
  });
});
