import type { LucideIcon } from "lucide-solid";
import { createEffect, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { Icon } from "./Icon";
import { Tooltip } from "./Tooltip";

export interface SegmentedOption<T extends string> {
  value: T;
  label?: JSX.Element;
  icon?: LucideIcon;
  /** Disabled options stay focusable-by-pointer for their tooltip but cannot be selected. */
  disabled?: boolean;
  tooltip?: string;
  ariaLabel?: string;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  "aria-label": string;
  fullWidth?: boolean;
  class?: string;
}

export function SegmentedControl<T extends string>(props: SegmentedControlProps<T>) {
  let root!: HTMLDivElement;
  const [thumb, setThumb] = createSignal({ x: 0, w: 0, ready: false });

  const measure = () => {
    const el = root.querySelector<HTMLElement>('[aria-checked="true"]');
    if (el) setThumb((t) => ({ x: el.offsetLeft, w: el.offsetWidth, ready: t.ready || el.offsetWidth > 0 }));
  };
  onMount(() => {
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    onCleanup(() => ro.disconnect());
  });
  createEffect(() => {
    props.value;
    props.options;
    queueMicrotask(measure);
  });

  const enabled = () => props.options.filter((o) => !o.disabled);
  const tabbable = (o: SegmentedOption<T>) => (o.value === props.value && !o.disabled) || (!enabled().some((e) => e.value === props.value) && o === enabled()[0]);

  const onKeyDown = (e: KeyboardEvent) => {
    const list = enabled();
    const i = list.findIndex((o) => o.value === props.value);
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (i + 1) % list.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    if (next < 0 || !list.length) return;
    e.preventDefault();
    props.onChange(list[next].value);
    queueMicrotask(() => root.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  };

  return (
    <div
      ref={root}
      role="radiogroup"
      aria-label={props["aria-label"]}
      class={props.class ? `ui-seg ${props.class}` : "ui-seg"}
      data-size={props.size ?? "md"}
      data-full={props.fullWidth ? "" : undefined}
      data-ready={thumb().ready ? "" : undefined}
      style={{ "--seg-x": `${thumb().x}px`, "--seg-w": `${thumb().w}px` }}
      onKeyDown={onKeyDown}
    >
      <span class="ui-seg__thumb" aria-hidden="true" />
      <For each={props.options}>
        {(o) => {
          const btn = (
            <button
              type="button"
              role="radio"
              class="ui-seg__item"
              aria-checked={o.value === props.value}
              aria-disabled={o.disabled ? "true" : undefined}
              aria-label={o.ariaLabel}
              tabIndex={tabbable(o) ? 0 : -1}
              onClick={() => !o.disabled && props.onChange(o.value)}
            >
              <Show when={o.icon}>{(i) => <Icon icon={i()} size={14} />}</Show>
              <Show when={o.label !== undefined}>
                <span>{o.label}</span>
              </Show>
            </button>
          );
          return o.tooltip ? <Tooltip label={o.tooltip}>{btn}</Tooltip> : btn;
        }}
      </For>
    </div>
  );
}
