import type { LucideIcon } from "lucide-solid";
import { splitProps, Show, type JSX } from "solid-js";
import { Icon } from "./Icon";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, keeps the width, and ignores clicks. Focus is kept. */
  loading?: boolean;
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  fullWidth?: boolean;
  children?: JSX.Element;
}

export function Button(props: ButtonProps) {
  const [local, rest] = splitProps(props, ["variant", "size", "loading", "icon", "iconRight", "fullWidth", "children", "class", "onClick", "type"]);
  const iconSize = () => (local.size === "lg" ? 16 : 14);
  return (
    <button
      {...rest}
      type={local.type ?? "button"}
      class={local.class ? `ui-btn ${local.class}` : "ui-btn"}
      data-variant={local.variant ?? "secondary"}
      data-size={local.size ?? "md"}
      data-loading={local.loading ? "" : undefined}
      data-full={local.fullWidth ? "" : undefined}
      aria-busy={local.loading ? "true" : undefined}
      onClick={(e) => {
        if (local.loading) return e.preventDefault();
        const h = local.onClick;
        if (typeof h === "function") h(e);
        else if (h) h[0](h[1], e);
      }}
    >
      <Show when={local.icon}>{(i) => <Icon icon={i()} size={iconSize()} />}</Show>
      <Show when={local.children !== undefined}>
        <span class="ui-btn__label">{local.children}</span>
      </Show>
      <Show when={local.iconRight}>{(i) => <Icon icon={i()} size={iconSize()} />}</Show>
      <Show when={local.loading}>
        <span class="ui-btn__spinner">
          <Spinner size={iconSize()} />
        </span>
      </Show>
    </button>
  );
}
