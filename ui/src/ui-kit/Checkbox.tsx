import { createEffect, createMemo, Show, splitProps, type JSX } from "solid-js";
import { ariaChecked, nextCheckState, type CheckState } from "./checkbox-logic";

export interface CheckboxProps {
  checked: CheckState;
  /** Receives the requested state; the caller owns the state (controlled). */
  onChange?: (next: boolean, event: Event) => void;
  label?: JSX.Element;
  disabled?: boolean;
  size?: "sm" | "md";
  id?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  tabIndex?: number;
  class?: string;
  ref?: (el: HTMLInputElement) => void;
}

export function Checkbox(props: CheckboxProps) {
  const [local, rest] = splitProps(props, ["checked", "onChange", "label", "disabled", "size", "class", "ref"]);
  let input!: HTMLInputElement;
  const sync = () => {
    input.checked = local.checked === true;
    input.indeterminate = local.checked === "mixed";
  };
  createEffect(sync);
  // Read in an event handler, where a compiler-wrapped prop getter would create a memo with no owner.
  const disabled = createMemo(() => local.disabled);
  const checked = createMemo(() => local.checked);
  return (
    <label
      class={local.class ? `ui-check ${local.class}` : "ui-check"}
      data-size={local.size ?? "md"}
      data-state={String(local.checked)}
      data-disabled={disabled() ? "" : undefined}
      // The box lives inside rows that have their own click behaviour.
      onClick={(e) => e.stopPropagation()}
    >
      <span class="ui-check__control">
        <input
          {...rest}
          ref={(el) => {
            input = el;
            local.ref?.(el);
          }}
          type="checkbox"
          class="ui-check__input"
          disabled={disabled()}
          aria-checked={ariaChecked(local.checked)}
          onChange={(e) => {
            if (disabled()) return;
            local.onChange?.(nextCheckState(checked()), e);
            // Stay controlled: if the parent did not accept the change, snap back.
            queueMicrotask(sync);
          }}
        />
        <span class="ui-check__box" aria-hidden="true">
          <svg viewBox="0 0 16 16" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path class="ui-check__tick" d="M4.2 8.4 6.9 11 11.8 5.2" pathLength="16" />
            <path class="ui-check__dash" d="M4.6 8h6.8" pathLength="10" />
          </svg>
        </span>
      </span>
      <Show when={local.label !== undefined}>
        <span class="ui-check__label">{local.label}</span>
      </Show>
    </label>
  );
}
