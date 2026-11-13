import type { LucideIcon } from "lucide-solid";
import { Show, splitProps, type JSX } from "solid-js";
import { Icon } from "./Icon";

export interface ChipProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  /** 28 px (default) or 26 px. */
  size?: "sm" | "md";
  /** Makes the chip a toggle: quiet while false, the accent tint while true (`aria-pressed`). */
  pressed?: boolean;
  /** A count after the label ("Needs you 2"). */
  count?: number;
  /** Dashed and quiet: "All prompts", "2 more". */
  dashed?: boolean;
  icon?: LucideIcon;
  children?: JSX.Element;
}

/** A small capsule button: a filter with a count, a saved prompt, an overflow entry. A group of toggles sits in a `role="group"`. */
export function Chip(props: ChipProps) {
  const [local, rest] = splitProps(props, ["size", "pressed", "count", "dashed", "icon", "children", "class", "type"]);
  return (
    <button {...rest} type={local.type ?? "button"} class={local.class ? `ui-chip ${local.class}` : "ui-chip"} data-size={local.size ?? "md"} data-dashed={local.dashed ? "" : undefined} aria-pressed={local.pressed}>
      <Show when={local.icon}>{(i) => <Icon icon={i()} size={14} />}</Show>
      <span class="ui-chip__text">{local.children}</span>
      <Show when={local.count !== undefined}>
        <span class="ui-chip__count">{local.count}</span>
      </Show>
    </button>
  );
}
