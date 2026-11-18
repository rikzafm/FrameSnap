/**
 * Service-worker message routing. Later tickets add handlers for the other
 * popup messages; for now the demo round trip and the picker are wired.
 */
import {
  isContentToWorker,
  type ContentToWorker,
  type PickerAction,
  type PopupToWorker,
  type WorkerToContent,
  type WorkerToPopup,
} from "../core/messages";
import type { SourceRef } from "../core/jobs/source-ref";
import { acceptsPicked } from "../core/jobs/source-ref";
import type { VideoSource } from "../core/model";

export interface RouterDeps {
  sendToTab(tabId: number, message: WorkerToContent): Promise<unknown>;
  /** The source reference saved with a resumable job (for the picker's bar text). */
  resumeRef?(jobId: string): Promise<SourceRef | undefined>;
}

export interface ContentSender {
  tabId: number;
  frameId: number;
}

export interface ContentDeps {
  resumeRef?(jobId: string): Promise<SourceRef | undefined>;
  /** A resume pick that passed `acceptsPicked`. */
  resumePicked?(jobId: string, tabId: number, source: VideoSource): void | Promise<void>;
  /** A plain pick: the popup should select this source. */
  onPicked?(tabId: number, source: VideoSource): void | Promise<void>;
  /** An action-bar button on the picked video. */
  onAction?(action: PickerAction, tabId: number, source: VideoSource): void | Promise<void>;
}

export async function routePopupMessage(msg: PopupToWorker, deps: RouterDeps): Promise<WorkerToPopup | undefined> {
  switch (msg.t) {
    case "demo/ping": {
      const res = await deps.sendToTab(msg.tabId, { t: "demo/ping", nonce: msg.nonce });
      if (!isContentToWorker(res) || res.t !== "demo/pong" || res.nonce !== msg.nonce) return undefined;
      return { t: "demo/pong", nonce: res.nonce, reply: res.reply };
    }
    case "picker/start": {
      const resumeTitle = msg.resumeJobId ? (await deps.resumeRef?.(msg.resumeJobId))?.title : undefined;
      await deps.sendToTab(msg.tabId, {
        t: "picker/start",
        ...(msg.resumeJobId ? { resumeJobId: msg.resumeJobId } : {}),
        ...(resumeTitle !== undefined ? { resumeTitle } : {}),
      });
      return undefined;
    }
    default:
      return undefined;
  }
}

/** A content script cannot know its own frame id; the sender tells us. */
const stamp = (source: VideoSource, frameId: number): VideoSource => ({
  ...source,
  frameRef: { frameId, elementKey: source.frameRef?.elementKey ?? "" },
});

export async function routeContentMessage(
  msg: ContentToWorker,
  sender: ContentSender,
  deps: ContentDeps,
): Promise<{ accepted: boolean } | undefined> {
  switch (msg.t) {
    case "picker/picked": {
      const source = stamp(msg.source, sender.frameId);
      if (msg.resumeJobId) {
        const ref = await deps.resumeRef?.(msg.resumeJobId);
        if (!ref || !acceptsPicked(ref, source)) return { accepted: false };
        await deps.resumePicked?.(msg.resumeJobId, sender.tabId, source);
        return { accepted: true };
      }
      await deps.onPicked?.(sender.tabId, source);
      return { accepted: true };
    }
    case "picker/action":
      await deps.onAction?.(msg.action, sender.tabId, stamp(msg.source, sender.frameId));
      return undefined;
    default:
      return undefined;
  }
}
