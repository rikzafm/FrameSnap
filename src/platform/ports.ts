/**
 * Port helpers: named popup port per tab, the engine port to the offscreen
 * document, and a connect wrapper that reconnects after the other side goes
 * away (the service worker can be suspended at any time).
 */

export const ENGINE_PORT = "engine";
const POPUP_PREFIX = "popup:";

export const popupPortName = (tabId: number) => `${POPUP_PREFIX}${tabId}`;

export function parsePopupPortName(name: string): number | undefined {
  if (!name.startsWith(POPUP_PREFIX)) return undefined;
  const raw = name.slice(POPUP_PREFIX.length);
  if (!/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

/** The subset of chrome.runtime.Port we use. */
export interface PortLike {
  name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (message: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

export interface ReconnectingPortOptions<M> {
  name: string;
  connect: (name: string) => PortLike;
  /** Receiver guard: messages failing it are dropped. */
  guard: (x: unknown) => x is M;
  onMessage: (m: M, port: PortLike) => void;
  /** Runs on every (re)connect, e.g. to re-announce state. */
  onConnect?: (port: PortLike) => void;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface ReconnectingPort {
  post(message: unknown): void;
  close(): void;
}

export function connectWithReconnect<M>(opts: ReconnectingPortOptions<M>): ReconnectingPort {
  const { baseDelayMs = 1000, maxDelayMs = 30000 } = opts;
  let port: PortLike | undefined;
  let closed = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    if (closed) return;
    const p = opts.connect(opts.name);
    port = p;
    p.onMessage.addListener((m) => {
      failures = 0;
      if (opts.guard(m)) opts.onMessage(m, p);
    });
    p.onDisconnect.addListener(() => {
      if (port === p) port = undefined;
      if (closed) return;
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** failures++);
      timer = setTimeout(open, delay);
    });
    opts.onConnect?.(p);
  };
  open();

  return {
    post(message) {
      port?.postMessage(message);
    },
    close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      port?.disconnect();
      port = undefined;
    },
  };
}
