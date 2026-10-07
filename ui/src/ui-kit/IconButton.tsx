import type { LucideIcon } from "lucide-solid";
import { splitProps, type JSX } from "solid-js";
import { Icon, type IconSize } from "./Icon";
import { Spinner } from "./Spinner";
import { Tooltip } from "./Tooltip";
import type { Placement } from "./position";

export interface IconButtonProps extends Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label" | "disabled"> {
  icon: LucideIcon;
  /** Required accessible name; also the tooltip text unless `tooltip` is set. */
  label: string;
  /** Tooltip text when it should differ from the label (e.g. why it is disabled). */
  tooltip?: string;
  shortcut?: string[];
  tooltipPlacement?: Placement;
  size?: "sm" | "md" | "lg";
  variant?: "ghost" | "secondary";
  /** Toggle state; sets aria-pressed. */
  pressed?: boolean;
  loading?: boolean;
  /** Uses aria-disabled so the tooltip still works and focus is kept. */
  disabled?: boolean;
  iconSize?: IconSize;
}

export function IconButton(props: IconButtonProps) {
  const [local, rest] = splitProps(props, [
    "icon", "label", "tooltip", "shortcut", "tooltipPlacement", "size", "variant", "pressed", "loading", "disabled", "iconSize", "class", "onClick", "type",
  ]);
  const inert = () => local.disabled || local.loading;
  return (
    <Tooltip label={local.tooltip ?? local.label} shortcut={local.shortcut} placement={local.tooltipPlacement}>
      <button
        {...rest}
        type={local.type ?? "button"}
        class={local.class ? `ui-icon-btn ${local.class}` : "ui-icon-btn"}
        data-variant={local.variant ?? "ghost"}
        data-size={local.size ?? "md"}
        data-loading={local.loading ? "" : undefined}
        aria-label={local.label}
        aria-pressed={local.pressed === undefined ? undefined : local.pressed}
        aria-disabled={local.disabled ? "true" : undefined}
        aria-busy={local.loading ? "true" : undefined}
        onClick={(e) => {
          if (inert()) return e.preventDefault();
          const h = local.onClick;
          if (typeof h === "function") h(e);
          else if (h) h[0](h[1], e);
        }}
      >
        {local.loading ? <Spinner size={local.iconSize === 16 ? 16 : 14} /> : <Icon icon={local.icon} size={local.iconSize ?? (local.size === "lg" ? 16 : 14)} />}
      </button>
    </Tooltip>
  );
}
