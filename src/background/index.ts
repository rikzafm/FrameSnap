import { isPopupToWorker } from "../core/messages";
import { parsePopupPortName } from "../platform/ports";
import { runtime, tabs } from "../platform/chrome";
import { routePopupMessage } from "./router";

runtime.onConnect.addListener((port) => {
  if (parsePopupPortName(port.name) === undefined) return;
  port.onMessage.addListener((raw: unknown) => {
    if (!isPopupToWorker(raw)) return;
    void routePopupMessage(raw, { sendToTab: (tabId, m) => tabs.sendMessage(tabId, m) })
      .then((reply) => {
        if (reply) port.postMessage(reply);
      })
      .catch(() => undefined);
  });
});
