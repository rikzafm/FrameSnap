import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENGINE_PORT, connectWithReconnect, parsePopupPortName, popupPortName, type PortLike } from "../../src/platform/ports";

class FakePort implements PortLike {
  sent: unknown[] = [];
  private msg: ((m: unknown) => void)[] = [];
  private disc: (() => void)[] = [];
  constructor(public name: string) {}
  postMessage(m: unknown) {
    this.sent.push(m);
  }
  onMessage = { addListener: (fn: (m: unknown) => void) => void this.msg.push(fn) };
  onDisconnect = { addListener: (fn: () => void) => void this.disc.push(fn) };
  disconnect() {}
  emit(m: unknown) {
    this.msg.forEach((f) => f(m));
  }
  drop() {
    this.disc.forEach((f) => f());
  }
}

describe("port names", () => {
  it("round-trips the per-tab popup port name", () => {
    expect(parsePopupPortName(popupPortName(42))).toBe(42);
    expect(parsePopupPortName("popup:abc")).toBeUndefined();
    expect(parsePopupPortName(ENGINE_PORT)).toBeUndefined();
    expect(parsePopupPortName("popup:-1")).toBeUndefined();
  });
});

describe("connectWithReconnect", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("only delivers messages that pass the guard", () => {
    const ports: FakePort[] = [];
    const got: unknown[] = [];
    connectWithReconnect({
      name: "x",
      connect: (n) => {
        const p = new FakePort(n);
        ports.push(p);
        return p;
      },
      guard: (m): m is number => typeof m === "number",
      onMessage: (m) => got.push(m),
    });
    ports[0]!.emit(1);
    ports[0]!.emit("bad");
    expect(got).toEqual([1]);
  });

  it("reconnects after disconnect with backoff and re-announces", () => {
    const ports: FakePort[] = [];
    const conn = connectWithReconnect({
      name: "x",
      connect: (n) => {
        const p = new FakePort(n);
        ports.push(p);
        return p;
      },
      guard: (m): m is number => typeof m === "number",
      onMessage: () => {},
      onConnect: (p) => p.postMessage("hello"),
    });
    expect(ports[0]!.sent).toEqual(["hello"]);
    ports[0]!.drop();
    expect(ports).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(ports).toHaveLength(2);
    expect(ports[1]!.sent).toEqual(["hello"]);
    conn.post("m");
    expect(ports[1]!.sent).toEqual(["hello", "m"]);
    conn.close();
    ports[1]!.drop();
    vi.advanceTimersByTime(60000);
    expect(ports).toHaveLength(2);
  });
});
