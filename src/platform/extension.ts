/**
 * Extension APIs that must stay importable from a content script or an
 * isolated-world bridge, where `chrome.webRequest`, `chrome.tabs` and friends
 * do not exist. Unlike `chrome.ts`, nothing here touches `chrome.*` at import
 * time: every access happens inside a function.
 */

export const messaging = {
  /** Fire-and-forget to the service worker; a missing receiver is not an error. */
  send(message: unknown): void {
    chrome.runtime.sendMessage(message).catch(() => undefined);
  },
  onMessage(listener: (raw: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean | undefined): void {
    chrome.runtime.onMessage.addListener(listener);
  },
};

export const localSettings = {
  get: (key: string): Promise<unknown> => chrome.storage.local.get(key).then((got) => got[key]),
  /** Calls `listener` with the new value whenever `key` changes in local storage. */
  watch(key: string, listener: (value: unknown) => void): void {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[key]) listener(changes[key].newValue);
    });
  },
};

export const manifest = {
  version: (): string => chrome.runtime.getManifest().version,
  hostPermissions: (): string[] => chrome.runtime.getManifest().host_permissions ?? [],
  /** The files of the all-pages content script, for injecting it into an already open tab. */
  contentScriptFiles: (): string[] => chrome.runtime.getManifest().content_scripts?.[0]?.js ?? [],
};

export const lifecycle = {
  /** Runs `listener` with the reason (`install`, `update`, ...) when the extension is installed or updated. */
  onInstalled(listener: (reason: string) => void): void {
    chrome.runtime.onInstalled.addListener((details) => listener(details.reason));
  },
  onStartup(listener: () => void): void {
    chrome.runtime.onStartup.addListener(listener);
  },
  openOptionsPage: (): Promise<void> => chrome.runtime.openOptionsPage(),
  openPopup: (): Promise<void> => chrome.action.openPopup(),
};

export const commands = {
  onCommand(listener: (command: string, tabId: number | undefined) => void): void {
    chrome.commands.onCommand.addListener((command, tab) => listener(command, tab?.id));
  },
};

export const capture = {
  visibleTab: (windowId: number): Promise<string> => chrome.tabs.captureVisibleTab(windowId, { format: "png" }),
};
