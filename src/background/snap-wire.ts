/**
 * Chrome wiring for the frame-snap service: real tabs, downloads, storage and
 * image cropping, the Alt+Shift+S command, and the popup / page messages.
 */
import type { ContentToWorker, PopupToWorker } from '../core/messages';
import { SNAP_PREFS_KEY, cropRect, mimeOf, normalizeSnapOptions } from '../core/snap';
import { downloads, storage, tabs } from '../platform/chrome';
import { capture, commands } from '../platform/extension';
import { settingsStore } from '../platform/settings-store';
import { createSnapService, type SnapService } from './snap';
import { createTabRegistry } from './registry';

export const SNAP_COMMAND = 'snap-frame';

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function createChromeSnapService(
  registry: Pick<ReturnType<typeof createTabRegistry>, 'list'>,
): SnapService {
  return createSnapService({
    sendToTab: (tabId, msg, frameId) => tabs.sendMessage(tabId, msg, frameId),
    findSource: async (tabId, id) => (await registry.list(tabId)).find((s) => s.id === id),
    // the registry lists best first; only a video with a page element can be snapped
    bestSource: async (tabId) => (await registry.list(tabId)).find((s) => s.frameRef?.elementKey),
    getPrefs: async () => ({
      options: normalizeSnapOptions((await storage.local.get(SNAP_PREFS_KEY))[SNAP_PREFS_KEY]),
      template: (await settingsStore().get()).filenameTemplate,
    }),
    download: (url, filename) =>
      downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false }),
    captureVisibleTab: async (tabId) => {
      const tab = await tabs.get(tabId);
      return capture.visibleTab(tab.windowId);
    },
    async cropImage(dataUrl, css, dpr, format, quality) {
      const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
      const r = cropRect(css, dpr, bmp);
      if (r.width === 0 || r.height === 0) throw new Error('empty crop');
      const canvas = new OffscreenCanvas(r.width, r.height);
      canvas.getContext('2d')!.drawImage(bmp, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
      bmp.close();
      const mime = mimeOf(format);
      const blob = await canvas.convertToBlob({ type: mime, quality });
      return {
        dataUrl: `data:${mime};base64,${toBase64(new Uint8Array(await blob.arrayBuffer()))}`,
        width: r.width,
        height: r.height,
      };
    },
    now: () => new Date(),
  });
}

/** Popup messages for snapping. Returns true when the message was ours. */
export function handlePopupSnap(snap: SnapService, msg: PopupToWorker): boolean {
  switch (msg.t) {
    case 'snap/frame':
      void snap.frame(msg.tabId, {
        ...(msg.sourceId ? { sourceId: msg.sourceId } : {}),
        ...(msg.options ? { options: msg.options } : {}),
      });
      return true;
    case 'snap/step':
      void snap.step(msg.tabId, msg.dir, msg.sourceId);
      return true;
    case 'snap/burst':
      void snap.burst(msg.tabId, {
        intervalSec: msg.intervalSec,
        ...(msg.sourceId ? { sourceId: msg.sourceId } : {}),
        ...(msg.options ? { options: msg.options } : {}),
      });
      return true;
    case 'snap/burst-stop':
      void snap.stopBurst(msg.tabId);
      return true;
    default:
      return false;
  }
}

export function isSnapContentMessage(msg: ContentToWorker): boolean {
  return msg.t === 'snap/data' || msg.t === 'snap/tainted';
}

/** The Alt+Shift+S command snaps the video on the active tab. */
export function listenForSnapCommand(snap: SnapService): void {
  commands.onCommand((command, tabId) => {
    if (command !== SNAP_COMMAND) return;
    const run = async () => {
      const id = tabId ?? (await tabs.query({ active: true, currentWindow: true }))[0]?.id;
      if (id !== undefined) await snap.frame(id, {});
    };
    void run().catch(() => undefined);
  });
}
