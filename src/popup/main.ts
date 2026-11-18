import { isWorkerToPopup } from "../core/messages";
import { connectWithReconnect, popupPortName } from "../platform/ports";
import { runtime, tabs } from "../platform/chrome";

/** Demo round trip (popup -> worker -> content -> worker -> popup); replaced by the real UI in ticket 06. */
async function demo() {
  const [tab] = await tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined) return;
  const tabId = tab.id;
  const nonce = crypto.randomUUID();
  const conn = connectWithReconnect({
    name: popupPortName(tabId),
    connect: runtime.connect,
    guard: isWorkerToPopup,
    onMessage: (m) => {
      if (m.t === "demo/pong" && m.nonce === nonce) {
        document.documentElement.dataset.demo = m.reply;
        conn.close();
      }
    },
    onConnect: (port) => port.postMessage({ t: "demo/ping", tabId, nonce }),
  });
}

void demo();
