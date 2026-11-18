import { isWorkerToPopup } from "../core/messages";
import type { JobRecord } from "../core/jobs/job";
import { resumableOn } from "../core/jobs/job";
import { canonicalPageUrl } from "../core/jobs/source-ref";
import { SNAP_PREFS_KEY, normalizeSnapOptions } from "../core/snap";
import { JOB_PREFIX } from "../background/job-store";
import { permissions, runtime, scripting, storage, tabs } from "../platform/chrome";
import { connectWithReconnect, popupPortName } from "../platform/ports";
import { settingsStore } from "../platform/settings-store";
import { originPattern, requestSiteAccess } from "../platform/site-access";
import { createPopup } from "./app";
import { createModeMemory } from "./mode-memory";

async function boot() {
  const root = document.getElementById("app")!;
  // Paint the shell immediately; data arrives afterwards.
  const [tab] = await tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  const tabId = tab.id;
  const url = tab.url ?? "";

  const memory = createModeMemory(storage.local);
  const [settings, mode, hasAccess] = await Promise.all([
    settingsStore().get(),
    memory.get(url),
    (async () => {
      const origin = originPattern(url);
      return origin ? permissions.contains({ origins: [origin] }) : false;
    })(),
  ]);
  document.documentElement.dataset.theme = settings.theme === "system" ? undefined : settings.theme;
  if (settings.theme === "system") delete document.documentElement.dataset.theme;

  const siteDeps = {
    permissions,
    injectContent: async (id: number) => {
      const files = chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [];
      await scripting.executeScript({ target: { tabId: id, allFrames: true }, files });
    },
  };

  const conn = connectWithReconnect({
    name: popupPortName(tabId),
    connect: runtime.connect,
    guard: isWorkerToPopup,
    onMessage: (m) => popup.handle(m),
    onConnect: (port) => port.postMessage({ t: "media/list", tabId }),
  });

  const popup = createPopup(root, {
    tab: { id: tabId, url },
    post: (m) => conn.post(m),
    requestAccess: () => requestSiteAccess(tabId, url, siteDeps),
    now: () => new Date(),
    defaults: { format: settings.defaultFormat, filenameTemplate: settings.filenameTemplate, quality: settings.defaultQuality, audio: settings.defaultAudio },
    firstRun: settings.acknowledged ? undefined : { onAcknowledge: () => void settingsStore().set({ acknowledged: true }) },
    mode,
    onModeChange: (m) => void memory.set(url, m),
    hasAccess,
    snap: {
      options: normalizeSnapOptions((await storage.local.get(SNAP_PREFS_KEY))[SNAP_PREFS_KEY]),
      onChange: (o) => void storage.local.set({ [SNAP_PREFS_KEY]: o }),
    },
  });

  const stored = await storage.local.get(null);
  const jobs = Object.entries(stored)
    .filter(([k]) => k.startsWith(JOB_PREFIX))
    .map(([, v]) => v as JobRecord);
  popup.setResumable(resumableOn(jobs, canonicalPageUrl(url)));
}

void boot();
