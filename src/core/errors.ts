/** One error vocabulary for every component (spec §7). */

export type ErrorCode =
  | "network"
  | "expired"
  | "drm"
  | "too-large"
  | "oom"
  | "tainted"
  | "unsupported"
  | "permission"
  | "changed"
  | "not-found"
  | "quota"
  | "cancelled"
  | "internal";

export interface AppError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export type ErrorAction = "resume" | "retry" | "pick" | "grant" | "lower-quality" | "none";

interface ErrorCopy {
  message: string;
  retryable: boolean;
  action: ErrorAction;
}

/** Copy and primary action per code. The popup, picker bar and toasts all read this table. */
export const ERROR_COPY: Record<ErrorCode, ErrorCopy> = {
  network: { message: "The connection dropped. Your progress is saved.", retryable: true, action: "resume" },
  expired: {
    message: "The video link may have expired. Frame Snap will look for the video again.",
    retryable: true,
    action: "resume",
  },
  drm: { message: "This video is protected and cannot be saved.", retryable: false, action: "none" },
  "too-large": {
    message: "This file is too large to convert in the browser. Pick a lower quality or trim it.",
    retryable: false,
    action: "lower-quality",
  },
  oom: { message: "The browser ran out of memory while converting. Try a shorter range.", retryable: true, action: "retry" },
  tainted: { message: "This frame could not be read directly. Captured at screen resolution.", retryable: false, action: "none" },
  unsupported: { message: "This video format is not supported.", retryable: false, action: "none" },
  permission: { message: "Frame Snap needs access to this site.", retryable: true, action: "grant" },
  changed: { message: "The video changed since the last attempt. Starting over.", retryable: true, action: "retry" },
  "not-found": {
    message: "Frame Snap could not find this video on the page. Select it to continue.",
    retryable: true,
    action: "pick",
  },
  quota: { message: "Not enough browser storage to keep a resumable copy.", retryable: true, action: "retry" },
  cancelled: { message: "Cancelled.", retryable: true, action: "retry" },
  internal: { message: "Something went wrong.", retryable: true, action: "retry" },
};

export function appError(code: ErrorCode, detail?: string): AppError {
  const copy = ERROR_COPY[code];
  return { code, message: detail ? `${copy.message} (${detail})` : copy.message, retryable: copy.retryable };
}

export class FrameSnapError extends Error {
  readonly appError: AppError;
  constructor(code: ErrorCode, detail?: string) {
    super(detail ?? code);
    this.name = "FrameSnapError";
    this.appError = appError(code, detail);
  }
}

/** Map anything thrown to an AppError. */
export function toAppError(err: unknown): AppError {
  if (err instanceof FrameSnapError) return err.appError;
  if (err instanceof DOMException && err.name === "AbortError") return appError("cancelled");
  if (err instanceof DOMException && err.name === "QuotaExceededError") return appError("quota");
  if (err instanceof TypeError) return appError("network", err.message);
  return appError("internal", err instanceof Error ? err.message : String(err));
}

/** HTTP status → error code, for fetches of media the user chose. */
export function httpError(status: number): FrameSnapError {
  if (status === 401 || status === 403 || status === 404 || status === 410) return new FrameSnapError("expired", `HTTP ${status}`);
  return new FrameSnapError("network", `HTTP ${status}`);
}
