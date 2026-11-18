/**
 * The service worker's end of the "engine" port. The offscreen document
 * connects when it loads, so a command sent right after creating the document
 * has to wait for that connection.
 */
import { appError, FrameSnapError } from "../core/errors";
import type { WorkerToEngine } from "../core/engine-messages";

export interface EnginePort {
  postMessage(message: unknown): void;
}

export interface EngineLinkOptions {
  /** Creates the offscreen document if it does not exist. */
  ensure(): Promise<void>;
  /** How long to wait for the document to connect. */
  timeoutMs?: number;
}

export interface EngineLink {
  attach(port: EnginePort): void;
  /** Forget the port (only if it is still the current one). */
  detach(port: EnginePort): void;
  send(msg: WorkerToEngine): Promise<void>;
}

export function createEngineLink({ ensure, timeoutMs = 10_000 }: EngineLinkOptions): EngineLink {
  let port: EnginePort | undefined;
  let waiters: ((p: EnginePort) => void)[] = [];

  return {
    attach(p) {
      port = p;
      const w = waiters;
      waiters = [];
      for (const fn of w) fn(p);
    },
    detach(p) {
      if (port === p) port = undefined;
    },
    async send(msg) {
      await ensure();
      const target =
        port ??
        (await new Promise<EnginePort>((resolve, reject) => {
          const timer = setTimeout(() => {
            waiters = waiters.filter((w) => w !== onPort);
            reject(new FrameSnapError("internal", appError("internal", "the converter did not start").message));
          }, timeoutMs);
          const onPort = (p: EnginePort) => {
            clearTimeout(timer);
            resolve(p);
          };
          waiters.push(onPort);
        }));
      target.postMessage(msg);
    },
  };
}
