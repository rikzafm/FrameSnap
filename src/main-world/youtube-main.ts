/** Main-world entry for youtube.com. Posts the player response to the bridge. */
import { YT_TAP_KIND } from '../adapters/youtube';
import { TAP_CHANNEL, TAP_INIT_CHANNEL } from './protocol';
import { readPlayerResponse } from './youtube-reader';

let nonce: string | undefined;
let lastVideoId: string | undefined;

function post(): void {
  if (nonce === undefined) return;
  const response = readPlayerResponse(window, document) as
    { videoDetails?: { videoId?: string } } | undefined;
  const id = response?.videoDetails?.videoId;
  // no streamingData check: a SABR-only response still names the video the worker looks up
  if (!response || !id || id === lastVideoId) return;
  lastVideoId = id;
  window.postMessage(
    { channel: TAP_CHANNEL, nonce, payload: { kind: YT_TAP_KIND, response } },
    location.origin,
  );
}

window.addEventListener('message', (e: MessageEvent) => {
  if (nonce !== undefined || e.source !== window || e.origin !== location.origin) return;
  const d: unknown = e.data;
  if (typeof d !== 'object' || d === null) return;
  const m = d as { channel?: unknown; nonce?: unknown };
  if (m.channel === TAP_INIT_CHANNEL && typeof m.nonce === 'string' && m.nonce) {
    nonce = m.nonce;
    post();
  }
});
document.addEventListener('yt-navigate-finish', post);
window.addEventListener('load', post);
