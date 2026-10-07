import type { LucideIcon } from "lucide-solid";
import { Dynamic } from "solid-js/web";

export type IconSize = 12 | 14 | 16 | 20 | 24;

export interface IconProps {
  icon: LucideIcon;
  /** 14 for dense rows and toolbars, 16 for standalone controls. */
  size?: IconSize;
  /** Accessible name. Omit for decorative icons (they are hidden from assistive tech). */
  label?: string;
  class?: string;
}

/** Thin wrapper so every icon in the app has the same stroke and a11y behaviour. */
export function Icon(props: IconProps) {
  const size = () => props.size ?? 16;
  return (
    <Dynamic
      component={props.icon}
      size={size()}
      // A hair lighter than lucide's 2 at 16 px; slightly heavier at 14 so it stays crisp.
      strokeWidth={size() <= 14 ? 1.9 : 1.75}
      class={props.class ? `ui-icon ${props.class}` : "ui-icon"}
      aria-hidden={props.label ? undefined : "true"}
      aria-label={props.label}
      role={props.label ? "img" : undefined}
    />
  );
}
