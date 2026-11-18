/**
 * Service-worker message routing. Later tickets add handlers for the other
 * popup messages; for now only the demo round trip is wired.
 */
import { isContentToWorker, type PopupToWorker, type WorkerToContent, type WorkerToPopup } from "../core/messages";

export interface RouterDeps {
  sendToTab(tabId: number, message: WorkerToContent): Promise<unknown>;
}

export async function routePopupMessage(msg: PopupToWorker, deps: RouterDeps): Promise<WorkerToPopup | undefined> {
  switch (msg.t) {
    case "demo/ping": {
      const res = await deps.sendToTab(msg.tabId, { t: "demo/ping", nonce: msg.nonce });
      if (!isContentToWorker(res) || res.t !== "demo/pong" || res.nonce !== msg.nonce) return undefined;
      return { t: "demo/pong", nonce: res.nonce, reply: res.reply };
    }
    default:
      return undefined;
  }
}
