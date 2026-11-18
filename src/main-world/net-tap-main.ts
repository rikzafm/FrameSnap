/** Main-world entry (document_start on x.com / twitter.com). Waits for the bridge's nonce, then taps. */
import { installNetTap } from "./net-tap";
import { TAP_INIT_CHANNEL } from "./protocol";

let nonce: string | undefined;
window.addEventListener("message", (e: MessageEvent) => {
  if (nonce !== undefined || e.source !== window || e.origin !== location.origin) return;
  const d: unknown = e.data;
  if (typeof d !== "object" || d === null) return;
  const m = d as { channel?: unknown; nonce?: unknown };
  if (m.channel === TAP_INIT_CHANNEL && typeof m.nonce === "string" && m.nonce) nonce = m.nonce;
});

installNetTap(window, () => nonce);
