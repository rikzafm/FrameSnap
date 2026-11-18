/**
 * postMessage protocol between the main-world network tap and the isolated
 * content script. Every message carries a per-page nonce the content script
 * hands to the tap; anything without it (page scripts, other frames) is dropped.
 */
export const TAP_CHANNEL = "framesnap/net-tap";
/** Content script -> main world: delivers the nonce. First message wins. */
export const TAP_INIT_CHANNEL = "framesnap/net-tap-init";

export interface TapMessage {
  channel: typeof TAP_CHANNEL;
  nonce: string;
  payload: unknown;
}

export interface TapReceiverOptions {
  nonce: string;
  /** The window whose messages are trusted (`event.source`). */
  window: unknown;
  origin: string;
  onPayload(payload: unknown): void;
}

export function createTapReceiver(opts: TapReceiverOptions): (e: MessageEvent) => void {
  return (e) => {
    if (e.source !== opts.window || e.origin !== opts.origin) return;
    const d: unknown = e.data;
    if (typeof d !== "object" || d === null) return;
    const m = d as Partial<TapMessage>;
    if (m.channel !== TAP_CHANNEL || m.nonce !== opts.nonce) return;
    opts.onPayload(m.payload);
  };
}
