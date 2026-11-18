/**
 * postMessage protocol between the MAIN-world MSE hook and the isolated
 * content script. The content script issues a per-page nonce; every message
 * after the handshake carries it and anything without it is dropped.
 *
 *   isolated -> main   init {nonce}                 (first one wins)
 *   main -> isolated   streams / stream {info}      (after init, and on change)
 *   isolated -> main   export {reqId, id}
 *   main -> isolated   exported {reqId, ...}        (Blob is structured-cloned, not copied)
 */
import type { ExportedStream, MseStore, StreamInfo } from "./mse-hook";

export const MSE_INIT_CHANNEL = "framesnap/mse-init";
export const MSE_REQ_CHANNEL = "framesnap/mse-req";
export const MSE_MSG_CHANNEL = "framesnap/mse";

/** The slice of `window` both halves use. */
export interface MsePostWindow {
  postMessage(data: unknown, targetOrigin: string): void;
  addEventListener(type: "message", fn: (e: MessageEvent) => void): void;
  location: { origin: string };
}

type MainToIso =
  | { t: "streams"; streams: StreamInfo[] }
  | { t: "stream"; info: StreamInfo }
  | { t: "exported"; reqId: number; result?: ExportedStream };

type IsoToMain = { t: "export"; reqId: number; id: string };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

function ownMessage(win: MsePostWindow, e: MessageEvent): Record<string, unknown> | undefined {
  if (e.source !== win || e.origin !== win.location.origin || !isObj(e.data)) return undefined;
  return e.data;
}

export interface MsePort {
  /** Tell the isolated side a stream changed (no-op until the handshake happened). */
  notify(info: StreamInfo): void;
}

/** MAIN-world half. */
export function createMsePort(win: MsePostWindow, store: MseStore): MsePort {
  let nonce: string | undefined;
  const post = (msg: MainToIso) => {
    if (nonce === undefined) return;
    win.postMessage({ channel: MSE_MSG_CHANNEL, nonce, msg }, win.location.origin);
  };
  win.addEventListener("message", (e) => {
    const d = ownMessage(win, e);
    if (!d) return;
    if (d.channel === MSE_INIT_CHANNEL) {
      if (nonce === undefined && typeof d.nonce === "string" && d.nonce) {
        nonce = d.nonce;
        post({ t: "streams", streams: store.streams() });
      }
      return;
    }
    if (d.channel !== MSE_REQ_CHANNEL || nonce === undefined || d.nonce !== nonce || !isObj(d.msg)) return;
    const req = d.msg as Partial<IsoToMain>;
    if (req.t === "export" && typeof req.reqId === "number" && typeof req.id === "string") {
      const result = store.export(req.id);
      post({ t: "exported", reqId: req.reqId, ...(result ? { result } : {}) });
    }
  });
  return { notify: (info) => post({ t: "stream", info }) };
}

export interface MseClient {
  streams(): StreamInfo[];
  byUrl(url: string): StreamInfo | undefined;
  /** Fires when a stream appears or grows. */
  onChange(fn: () => void): void;
  export(id: string): Promise<ExportedStream | undefined>;
}

/** Isolated-world half. */
export function createMseClient(win: MsePostWindow, nonce: string, timeoutMs = 30_000): MseClient {
  const known = new Map<string, StreamInfo>();
  const waiting = new Map<number, (r: ExportedStream | undefined) => void>();
  const listeners: (() => void)[] = [];
  let reqId = 0;

  win.addEventListener("message", (e) => {
    const d = ownMessage(win, e);
    if (!d || d.channel !== MSE_MSG_CHANNEL || d.nonce !== nonce || !isObj(d.msg)) return;
    const m = d.msg as Partial<MainToIso>;
    if (m.t === "streams" && Array.isArray(m.streams)) {
      for (const s of m.streams) known.set(s.id, s);
    } else if (m.t === "stream" && isObj(m.info) && typeof m.info.id === "string") {
      known.set(m.info.id, m.info);
    } else if (m.t === "exported" && typeof m.reqId === "number") {
      waiting.get(m.reqId)?.(m.result);
      waiting.delete(m.reqId);
      return;
    } else return;
    for (const fn of listeners) fn();
  });

  win.postMessage({ channel: MSE_INIT_CHANNEL, nonce }, win.location.origin);

  return {
    streams: () => [...known.values()],
    byUrl: (url) => [...known.values()].find((s) => s.url === url),
    onChange: (fn) => void listeners.push(fn),
    export(id) {
      const n = ++reqId;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(n);
          resolve(undefined);
        }, timeoutMs);
        waiting.set(n, (r) => {
          clearTimeout(timer);
          resolve(r);
        });
        win.postMessage({ channel: MSE_REQ_CHANNEL, nonce, msg: { t: "export", reqId: n, id } satisfies IsoToMain }, win.location.origin);
      });
    },
  };
}
