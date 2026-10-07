import { t } from "../i18n";
import type { LucideIcon } from "lucide-solid";
import type { JSX } from "solid-js";
import { Button, type ButtonSize } from "./Button";
import { ChevronDown } from "./icons";
import { Menu, type MenuEntry } from "./Menu";
import type { Placement } from "./position";

export interface SplitButtonProps {
  children: JSX.Element;
  onClick: () => void;
  /** Alternative actions in the dropdown. */
  items: MenuEntry[];
  variant?: "primary" | "secondary";
  size?: ButtonSize;
  icon?: LucideIcon;
  loading?: boolean;
  disabled?: boolean;
  /** Where the dropdown opens; it still flips when there is no room. Default "bottom-end", right-aligned with the toggle. */
  menuPlacement?: Placement;
  /** Accessible name of the dropdown toggle. */
  menuLabel?: string;
  class?: string;
}

/** A primary action with a dropdown of alternatives ("Commit and Push…", "Force push…"). */
export function SplitButton(props: SplitButtonProps) {
  return (
    <div class={props.class ? `ui-split ${props.class}` : "ui-split"} data-variant={props.variant ?? "primary"} data-size={props.size ?? "md"}>
      <Button variant={props.variant ?? "primary"} size={props.size} icon={props.icon} loading={props.loading} disabled={props.disabled} onClick={props.onClick}>
        {props.children}
      </Button>
      <Menu
        items={props.items}
        placement={props.menuPlacement ?? "bottom-end"}
        aria-label={props.menuLabel ?? t("kit.moreActions")}
        trigger={(tr) => (
          <Button {...tr} class="ui-split__toggle" variant={props.variant ?? "primary"} size={props.size} icon={ChevronDown} disabled={props.disabled || props.loading} aria-label={props.menuLabel ?? t("kit.moreActions")} />
        )}
      />
    </div>
  );
}
