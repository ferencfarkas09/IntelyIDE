import { t } from "../i18n";
import { For, Show, splitProps, type JSX } from "solid-js";
import { ChevronDown } from "./icons";
import { Icon } from "./Icon";

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string> extends Omit<JSX.SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange" | "size" | "children"> {
  options: readonly SelectOption<T>[];
  value: T | undefined;
  onChange: (value: T) => void;
  size?: "sm" | "md";
  invalid?: boolean;
  /** Shown as a disabled first entry while `value` is not among the options. */
  placeholder?: string;
  "aria-label": string;
  wrapperClass?: string;
}

/** A native dropdown in the field styling: keyboard, type-ahead and screen readers come from the platform. */
export function Select<T extends string>(props: SelectProps<T>) {
  const [local, rest] = splitProps(props, ["options", "value", "onChange", "size", "invalid", "placeholder", "class", "wrapperClass"]);
  const known = () => local.options.some((o) => o.value === local.value);
  return (
    <div class={local.wrapperClass ? `ui-input ui-select ${local.wrapperClass}` : "ui-input ui-select"} data-size={local.size ?? "md"} data-invalid={local.invalid ? "" : undefined} data-disabled={props.disabled ? "" : undefined}>
      <select {...rest} class={local.class ? `ui-input__field ${local.class}` : "ui-input__field"} value={local.value ?? ""} aria-invalid={local.invalid ? "true" : undefined} onChange={(e) => local.onChange(e.currentTarget.value as T)}>
        <Show when={!known()}>
          <option value="" disabled selected>
            {local.placeholder ?? t("kit.select")}
          </option>
        </Show>
        <For each={local.options}>
          {(o) => (
            <option value={o.value} disabled={o.disabled} selected={o.value === local.value}>
              {o.label}
            </option>
          )}
        </For>
      </select>
      <span class="ui-input__adorn ui-select__chevron" aria-hidden="true">
        <Icon icon={ChevronDown} size={14} />
      </span>
    </div>
  );
}
