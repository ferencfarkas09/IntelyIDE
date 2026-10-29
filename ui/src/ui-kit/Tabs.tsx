import { For, type JSX } from "solid-js";

export interface TabItem<T extends string> {
  value: T;
  label: JSX.Element;
  /** id of the panel this tab shows (aria-controls). */
  panelId?: string;
  disabled?: boolean;
}

export interface TabsProps<T extends string> {
  items: TabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  "aria-label": string;
  class?: string;
}

/** A tab list (WAI-ARIA tabs, automatic activation): arrow keys, Home and End move and select; one tab stop. Panels are the caller's. */
export function Tabs<T extends string>(props: TabsProps<T>) {
  let root!: HTMLDivElement;
  const enabled = () => props.items.filter((i) => !i.disabled);
  const onKeyDown = (e: KeyboardEvent) => {
    const list = enabled();
    const at = list.findIndex((i) => i.value === props.value);
    const rtl = getComputedStyle(root).direction === "rtl";
    const fwd = e.key === (rtl ? "ArrowLeft" : "ArrowRight");
    const back = e.key === (rtl ? "ArrowRight" : "ArrowLeft");
    const next = e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : fwd ? (at + 1) % list.length : back ? (at - 1 + list.length) % list.length : -1;
    if (next < 0 || !list.length) return;
    e.preventDefault();
    props.onChange(list[next].value);
    queueMicrotask(() => root.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };
  return (
    <div ref={root} role="tablist" aria-label={props["aria-label"]} class={props.class ? `ui-tabs ${props.class}` : "ui-tabs"} onKeyDown={onKeyDown}>
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            role="tab"
            class="ui-tabs__tab"
            aria-selected={item.value === props.value}
            aria-controls={item.panelId}
            aria-disabled={item.disabled ? "true" : undefined}
            tabIndex={item.value === props.value ? 0 : -1}
            onClick={() => !item.disabled && props.onChange(item.value)}
          >
            {item.label}
          </button>
        )}
      </For>
    </div>
  );
}
