/**
 * Renders any ErrorCode from ERROR_COPY with its primary action. Shared by the popup (inline and
 * toast); the picker bar draws the same copy with its own shadow-root styles.
 */
import { ERROR_COPY, type ErrorAction, type ErrorCode } from "../core/errors";
import { button, h } from "./components";

export type ErrorHandlers = Partial<Record<Exclude<ErrorAction, "none">, () => void>>;

const ACTION_LABEL: Record<Exclude<ErrorAction, "none">, string> = {
  resume: "Resume",
  retry: "Try again",
  pick: "Select video",
  grant: "Allow this site",
  "lower-quality": "Choose lower quality",
};

export function actionLabel(action: Exclude<ErrorAction, "none">): string {
  return ACTION_LABEL[action];
}

function actionButton(code: ErrorCode, handlers: ErrorHandlers): HTMLElement | undefined {
  const action = ERROR_COPY[code].action;
  if (action === "none") return undefined;
  const handler = handlers[action];
  return handler ? button(ACTION_LABEL[action], handler, { variant: "primary" }) : undefined;
}

export function errorNotice(code: ErrorCode, handlers: ErrorHandlers): HTMLElement {
  return h("div", { class: "notice", role: "alert", "data-error": code }, h("p", { class: "notice-text" }, ERROR_COPY[code].message), actionButton(code, handlers));
}

export function errorToast(code: ErrorCode, handlers: ErrorHandlers): HTMLElement {
  return h("div", { class: "toast toast-error", "data-error": code }, h("span", { class: "notice-text" }, ERROR_COPY[code].message), actionButton(code, handlers));
}
