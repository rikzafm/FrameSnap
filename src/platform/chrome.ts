/**
 * Thin, mockable wrappers over the extension APIs. Keep these free of logic:
 * anything worth testing lives in a module that takes one of these as a
 * dependency.
 */

export const runtime = {
  sendMessage: <T = unknown>(message: unknown): Promise<T> => chrome.runtime.sendMessage(message) as Promise<T>,
  onMessage: chrome.runtime.onMessage,
  onConnect: chrome.runtime.onConnect,
  connect: (name: string) => chrome.runtime.connect({ name }),
  getURL: (path: string) => chrome.runtime.getURL(path),
};

export const tabs = {
  sendMessage: <T = unknown>(tabId: number, message: unknown, frameId?: number): Promise<T> =>
    (frameId === undefined ? chrome.tabs.sendMessage(tabId, message) : chrome.tabs.sendMessage(tabId, message, { frameId })) as Promise<T>,
  query: (q: chrome.tabs.QueryInfo) => chrome.tabs.query(q),
  get: (tabId: number) => chrome.tabs.get(tabId),
  create: (p: chrome.tabs.CreateProperties) => chrome.tabs.create(p),
  onRemoved: chrome.tabs.onRemoved,
  onUpdated: chrome.tabs.onUpdated,
};

export const storage = {
  local: chrome.storage.local,
  onChanged: chrome.storage.onChanged,
};

export const session = {
  area: chrome.storage.session,
};

export const webRequest = {
  onHeadersReceived: chrome.webRequest.onHeadersReceived,
};

export const downloads = {
  download: (options: chrome.downloads.DownloadOptions) => chrome.downloads.download(options),
  search: (q: chrome.downloads.DownloadQuery) => chrome.downloads.search(q),
  resume: (id: number) => chrome.downloads.resume(id),
  cancel: (id: number) => chrome.downloads.cancel(id),
  removeFile: (id: number) => chrome.downloads.removeFile(id),
  erase: (q: chrome.downloads.DownloadQuery) => chrome.downloads.erase(q),
  show: (id: number) => chrome.downloads.show(id),
  onChanged: chrome.downloads.onChanged,
};

export const scripting = {
  executeScript: <A extends unknown[], R>(injection: chrome.scripting.ScriptInjection<A, R>) => chrome.scripting.executeScript(injection),
  getRegisteredContentScripts: (filter: chrome.scripting.ContentScriptFilter) => chrome.scripting.getRegisteredContentScripts(filter),
  registerContentScripts: (scripts: chrome.scripting.RegisteredContentScript[]) => chrome.scripting.registerContentScripts(scripts),
  updateContentScripts: (scripts: chrome.scripting.RegisteredContentScript[]) => chrome.scripting.updateContentScripts(scripts),
  unregisterContentScripts: (filter: chrome.scripting.ContentScriptFilter) => chrome.scripting.unregisterContentScripts(filter),
};

export const offscreen = {
  supported: () =>
    typeof chrome !== 'undefined' && typeof chrome.offscreen?.createDocument === 'function',
  async has(): Promise<boolean> {
    const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
    return contexts.length > 0;
  },
  create: (url: string, reasons: chrome.offscreen.Reason[], justification: string) =>
    chrome.offscreen.createDocument({ url, reasons, justification }),
  close: () => chrome.offscreen.closeDocument(),
};

export const alarms = {
  create: (name: string, info: chrome.alarms.AlarmCreateInfo) => chrome.alarms.create(name, info),
  clear: (name: string) => chrome.alarms.clear(name),
  onAlarm: chrome.alarms.onAlarm,
};

export const dnr = {
  updateSessionRules: (o: chrome.declarativeNetRequest.UpdateRuleOptions) => chrome.declarativeNetRequest.updateSessionRules(o),
  getSessionRules: () => chrome.declarativeNetRequest.getSessionRules(),
};

export const permissions = {
  contains: (p: chrome.permissions.Permissions) => chrome.permissions.contains(p),
  request: (p: chrome.permissions.Permissions) => chrome.permissions.request(p),
  getAll: () => chrome.permissions.getAll(),
  onAdded: chrome.permissions.onAdded,
  onRemoved: chrome.permissions.onRemoved,
  remove: (p: chrome.permissions.Permissions) => chrome.permissions.remove(p),
};

export const contextMenus = {
  create: (props: chrome.contextMenus.CreateProperties) =>
    new Promise<void>((resolve, reject) => {
      chrome.contextMenus.create(props, () => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    }),
  removeAll: () =>
    new Promise<void>((resolve) => {
      chrome.contextMenus.removeAll(() => resolve());
    }),
  onClicked: chrome.contextMenus.onClicked,
};
