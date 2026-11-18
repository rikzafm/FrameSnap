/**
 * Small DOM component kit shared by the popup and options page. Every control is a
 * real button/select/input (or an ARIA widget with its keyboard handling) and gets
 * its 44 px target from base.css.
 */

type Child = Node | string | false | null | undefined;
type Props = Record<string, string | number | boolean | undefined | ((e: Event) => void)>;

/** Create an element. `on*` props become listeners, `class` sets className, booleans toggle attributes. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

let uid = 0;
export const nextId = (prefix: string) => `${prefix}-${++uid}`;

export interface ButtonOpts {
  variant?: "primary" | "secondary" | "link";
  label?: string;
  disabled?: boolean;
  key?: string;
  expanded?: boolean;
  controls?: string;
}

export function button(text: Child, onClick: () => void, o: ButtonOpts = {}): HTMLButtonElement {
  return h(
    "button",
    {
      type: "button",
      class: `btn btn-${o.variant ?? "secondary"}`,
      "aria-label": o.label,
      disabled: o.disabled,
      "data-key": o.key,
      "aria-expanded": o.expanded === undefined ? undefined : String(o.expanded),
      "aria-controls": o.controls,
      onClick: () => onClick(),
    },
    text,
  );
}

/** Icon-only buttons must pass an aria-label. */
export function iconButton(icon: Child, label: string, onClick: () => void, key?: string): HTMLButtonElement {
  return button(icon, onClick, { label, key, variant: "secondary" });
}

export function selectRow(id: string, label: string, name: string, choices: { value: string; label: string }[], value: string, onChange: (v: string) => void, hint?: Child): HTMLElement {
  const select = h("select", { id, name, "data-key": name, onChange: (e) => onChange((e.target as HTMLSelectElement).value) });
  for (const c of choices) select.append(h("option", { value: c.value, selected: c.value === value }, c.label));
  select.value = value;
  return h("div", { class: "row" }, h("label", { class: "row-label", for: id }, label), h("div", { class: "row-control" }, select, hint));
}

/** Shared arrow-key behaviour for radiogroups: roving tabindex, selection follows focus. */
function wireRadios(group: HTMLElement, vertical: boolean, onPick: (i: number) => void) {
  group.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
    const cur = radios.findIndex((r) => r === document.activeElement || r === ke.target);
    const fwd = vertical ? ["ArrowDown", "ArrowRight"] : ["ArrowRight", "ArrowDown"];
    let next = -1;
    if (fwd.includes(ke.key)) next = (cur + 1) % radios.length;
    else if (["ArrowUp", "ArrowLeft"].includes(ke.key)) next = (cur - 1 + radios.length) % radios.length;
    else if (ke.key === "Home") next = 0;
    else if (ke.key === "End") next = radios.length - 1;
    if (next < 0) return;
    ke.preventDefault();
    onPick(next);
  });
}

/** Static, trusted SVG markup as an inline decorative icon. */
export function svgIcon(markup: string, cls = "icon"): HTMLElement {
  const el = h("span", { class: cls, "aria-hidden": "true" });
  el.innerHTML = markup;
  return el;
}

export const ICONS = {
  cursor: '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M4 3l16 7-7 2.5L10 20z"/></svg>',
  play: '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
  snap: '<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9V6a2 2 0 0 1 2-2h3M15 4h3a2 2 0 0 1 2 2v3M20 15v3a2 2 0 0 1-2 2h-3M9 20H6a2 2 0 0 1-2-2v-3"/><circle cx="12" cy="12" r="3"/></svg>',
};

export function segmented(labelId: string, choices: { value: string; label: string }[], value: string, onChange: (v: string) => void, extraClass = ""): HTMLElement {
  const group = h("div", { class: `segmented ${extraClass}`.trim(), role: "radiogroup", "aria-labelledby": labelId });
  for (const c of choices) {
    const on = c.value === value;
    group.append(h("button", { type: "button", role: "radio", class: "seg", "aria-checked": String(on), tabindex: on ? 0 : -1, "data-key": `seg-${c.value}`, onClick: () => onChange(c.value) }, c.label));
  }
  wireRadios(group, false, (i) => onChange(choices[i]!.value));
  return group;
}

export function switchControl(label: string, on: boolean, onToggle: () => void, key?: string): HTMLButtonElement {
  return h("button", { type: "button", role: "switch", class: "switch", "aria-checked": String(on), "aria-label": label, "data-key": key, onClick: () => onToggle() }, h("span", { class: "switch-thumb", "aria-hidden": "true" }));
}

export function chip(text: string): HTMLElement {
  return h("span", { class: "chip" }, text);
}

export function radioCards(labelText: string, items: { value: string; title: string; meta: string; thumbnail?: string }[], value: string, onChange: (v: string) => void): HTMLElement {
  const group = h("div", { class: "cards", role: "radiogroup", "aria-label": labelText });
  for (const it of items) {
    const on = it.value === value;
    group.append(
      h(
        "button",
        { type: "button", role: "radio", class: "card", "aria-checked": String(on), tabindex: on ? 0 : -1, "data-key": `card-${it.value}`, onClick: () => onChange(it.value) },
        it.thumbnail ? h("img", { class: "thumb", src: it.thumbnail, alt: "" }) : h("span", { class: "thumb thumb-empty", "aria-hidden": "true" }),
        h("span", { class: "card-text" }, h("span", { class: "card-title" }, it.title), h("span", { class: "card-meta" }, it.meta)),
        h("span", { class: "radio-dot", "aria-hidden": "true" }),
      ),
    );
  }
  wireRadios(group, true, (i) => onChange(items[i]!.value));
  return group;
}

export function tabs(labelText: string, items: { value: string; label: string }[], value: string, panelId: string, onChange: (v: string) => void): HTMLElement {
  const list = h("div", { class: "tabs", role: "tablist", "aria-label": labelText });
  for (const it of items) {
    const on = it.value === value;
    list.append(
      h("button", { type: "button", role: "tab", class: "tab", id: `tab-${it.value}`, "aria-selected": String(on), "aria-controls": panelId, tabindex: on ? 0 : -1, "data-key": `tab-${it.value}`, onClick: () => onChange(it.value) }, it.label),
    );
  }
  list.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    const i = items.findIndex((x) => x.value === value);
    let n = -1;
    if (ke.key === "ArrowRight") n = (i + 1) % items.length;
    else if (ke.key === "ArrowLeft") n = (i - 1 + items.length) % items.length;
    else if (ke.key === "Home") n = 0;
    else if (ke.key === "End") n = items.length - 1;
    if (n < 0) return;
    ke.preventDefault();
    onChange(items[n]!.value);
  });
  return list;
}

export function progress(label: string, percent: number): HTMLElement {
  return h(
    "div",
    { class: "progress", role: "progressbar", "aria-label": label, "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": percent },
    h("div", { class: "progress-fill", style: `width:${percent}%` }),
  );
}

/** Polite live region content; the host keeps the region mounted so screen readers announce changes. */
export function toast(text: string): HTMLElement {
  return h("div", { class: "toast" }, text);
}
