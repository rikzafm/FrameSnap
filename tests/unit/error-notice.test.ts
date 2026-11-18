// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ERROR_COPY, type ErrorAction, type ErrorCode } from "../../src/core/errors";
import { actionLabel, errorNotice, errorToast } from "../../src/ui/error-notice";

const codes = Object.keys(ERROR_COPY) as ErrorCode[];
const actionable = codes.filter((c) => ERROR_COPY[c].action !== "none");

describe("error notice", () => {
  it.each(codes)("%s renders its copy", (code) => {
    const el = errorNotice(code, {});
    expect(el.textContent).toContain(ERROR_COPY[code].message);
    expect(el.getAttribute("role")).toBe("alert");
  });

  it.each(actionable)("%s renders its action button and calls the handler", (code) => {
    const action = ERROR_COPY[code].action as Exclude<ErrorAction, "none">;
    const handler = vi.fn();
    const el = errorNotice(code, { [action]: handler });
    const btn = el.querySelector("button")!;
    expect(btn.textContent).toBe(actionLabel(action));
    btn.click();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("uses the five distinct action labels", () => {
    expect(new Set((["resume", "retry", "pick", "grant", "lower-quality"] as const).map(actionLabel)).size).toBe(5);
  });

  it("codes without an action render no button, and a missing handler hides it", () => {
    expect(errorNotice("drm", { retry: () => {} }).querySelector("button")).toBeNull();
    expect(errorNotice("network", {}).querySelector("button")).toBeNull();
  });

  it("toast variant carries the same copy and action in a toast", () => {
    const handler = vi.fn();
    const el = errorToast("permission", { grant: handler });
    expect(el.className).toContain("toast");
    expect(el.textContent).toContain(ERROR_COPY.permission.message);
    el.querySelector("button")!.click();
    expect(handler).toHaveBeenCalledOnce();
  });
});
