import { isContentToWorker, isPopupToWorker } from "../core/messages";
import type { JobRecord } from "../core/jobs/job";
import { parsePopupPortName } from "../platform/ports";
import { runtime, storage, tabs } from "../platform/chrome";
import { jobKey } from "./job-store";
import { routeContentMessage, routePopupMessage } from "./router";

/** Read-only lookup of a saved job's source reference. */
async function resumeRef(jobId: string) {
  const got = await storage.local.get(jobKey(jobId));
  return (got[jobKey(jobId)] as JobRecord | undefined)?.source;
}

/** Key the popup reads on open: which tab and source the picker asked for. */
export const PICKER_SELECTION_KEY = "pickerSelection";

runtime.onConnect.addListener((port) => {
  if (parsePopupPortName(port.name) === undefined) return;
  port.onMessage.addListener((raw: unknown) => {
    if (!isPopupToWorker(raw)) return;
    void routePopupMessage(raw, { sendToTab: (tabId, m) => tabs.sendMessage(tabId, m), resumeRef })
      .then((reply) => {
        if (reply) port.postMessage(reply);
      })
      .catch(() => undefined);
  });
});

runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (!isContentToWorker(raw) || sender.tab?.id === undefined) return false;
  const from = { tabId: sender.tab.id, frameId: sender.frameId ?? 0 };
  void routeContentMessage(raw, from, {
    resumeRef,
    // The resume flow (ticket 12) picks the job back up from here.
    resumePicked: async () => undefined,
    onPicked: async (tabId, source) => {
      await storage.local.set({ [PICKER_SELECTION_KEY]: { tabId, sourceId: source.id, tab: "list" } });
    },
    onAction: async (action, tabId, source) => {
      if (action !== "gif") return; // download and snap are wired by their own tickets
      await storage.local.set({ [PICKER_SELECTION_KEY]: { tabId, sourceId: source.id, tab: "gif" } });
      await chrome.action.openPopup().catch(() => undefined);
    },
  })
    .then((res) => sendResponse(res))
    .catch(() => sendResponse(undefined));
  return true;
});
