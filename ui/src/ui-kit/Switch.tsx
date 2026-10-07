import { Show, type JSX } from "solid-js";

export interface SwitchProps {
  checked: boolean;
  onChange?: (next: boolean) => void;
  label?: JSX.Element;
  disabled?: boolean;
  size?: "sm" | "md";
  id?: string;
  "aria-label"?: string;
  class?: string;
}

export function Switch(props: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      id={props.id}
      class={props.class ? `ui-switch ${props.class}` : "ui-switch"}
      data-size={props.size ?? "md"}
      aria-checked={props.checked}
      aria-label={props["aria-label"]}
      disabled={props.disabled}
      onClick={() => props.onChange?.(!props.checked)}
    >
      <span class="ui-switch__track">
        <span class="ui-switch__thumb" />
      </span>
      <Show when={props.label !== undefined}>
        <span class="ui-switch__label">{props.label}</span>
      </Show>
    </button>
  );
}
