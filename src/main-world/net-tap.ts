/**
 * Main-world network tap for x.com / twitter.com. Wraps `fetch` and XHR, and
 * forwards parsed GraphQL JSON (TweetDetail, timelines) to the isolated
 * content script over nonce-checked postMessage. Responses are cloned, so the
 * page sees them untouched.
 */
import { TAP_CHANNEL, type TapMessage } from "./protocol";

const GRAPHQL_RE = /^https?:\/\/(?:[a-z0-9-]+\.)*(?:x|twitter)\.com\/i\/api\/graphql\//i;
const MAX_BUFFER = 50;

export const isGraphqlUrl = (url: string): boolean => GRAPHQL_RE.test(url);

/** Nonce is a string once known; a getter lets the entry point wait for the handshake. */
export type NonceSource = string | (() => string | undefined);

export function installNetTap(win: Window & typeof globalThis, nonce: NonceSource): void {
  const pending: unknown[] = [];
  const currentNonce = () => (typeof nonce === "function" ? nonce() : nonce);

  const send = (payload: unknown) => {
    const n = currentNonce();
    if (n === undefined) {
      if (pending.length < MAX_BUFFER) pending.push(payload);
      return;
    }
    for (const p of pending.splice(0)) post(p, n);
    post(payload, n);
  };
  const post = (payload: unknown, n: string) => {
    const msg: TapMessage = { channel: TAP_CHANNEL, nonce: n, payload };
    win.postMessage(msg, win.location.origin);
  };

  const origFetch = win.fetch;
  win.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const res = await origFetch.apply(this ?? win, args);
    try {
      const input = args[0];
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (isGraphqlUrl(url)) {
        res
          .clone()
          .json()
          .then(send, () => {});
      }
    } catch {
      /* never break the page */
    }
    return res;
  } as typeof fetch;

  const Xhr = win.XMLHttpRequest as typeof XMLHttpRequest | undefined;
  if (!Xhr) return;
  const origOpen = Xhr.prototype.open;
  Xhr.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    try {
      const u = String(url);
      if (isGraphqlUrl(u)) {
        this.addEventListener("load", () => {
          try {
            const text = this.responseType === "" || this.responseType === "text" ? this.responseText : undefined;
            const body: unknown = this.responseType === "json" ? this.response : text ? JSON.parse(text) : undefined;
            if (body !== undefined && body !== null) send(body);
          } catch {
            /* ignore */
          }
        });
      }
    } catch {
      /* ignore */
    }
    return (origOpen as (...a: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;
}
