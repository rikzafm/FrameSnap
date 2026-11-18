import { OpfsChunkStore } from "../offscreen/opfs-chunk-store";
import { SNAP_PREFS_KEY, normalizeSnapOptions } from "../core/snap";
import { downloads, permissions, storage, tabs } from "../platform/chrome";
import { manifest } from "../platform/extension";
import { settingsStore } from "../platform/settings-store";
import { grantedSites, revokeSiteAccess } from "../platform/site-access";
import { createModeMemory } from "../popup/mode-memory";
import { createOptions } from "./app";
import { createOptionsData } from "./data";

async function boot() {
  const root = document.getElementById("app")!;
  const data = createOptionsData({ area: storage.local, chunks: new OpfsChunkStore() });
  // Partial data of a "Clear all" is deleted for good when the page closes.
  addEventListener("pagehide", () => data.flush());

  const memory = createModeMemory(storage.local);
  const builtIn = manifest.hostPermissions();
  const siteDeps = { permissions: { getAll: () => permissions.getAll(), remove: permissions.remove } };

  await createOptions(root, {
    settings: settingsStore(),
    snapPrefs: {
      get: async () => normalizeSnapOptions((await storage.local.get(SNAP_PREFS_KEY))[SNAP_PREFS_KEY]),
      set: (o) => storage.local.set({ [SNAP_PREFS_KEY]: o }),
    },
    data,
    modes: memory,
    sites: { list: () => grantedSites(siteDeps, builtIn), revoke: (origin) => revokeSiteAccess(origin, siteDeps) },
    now: () => new Date(),
    openUrl: (url) => void tabs.create({ url }),
    showDownload: (id) => void downloads.show(id),
    applyTheme: (theme) => {
      if (theme === "system") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = theme;
    },
  });
}

void boot();
