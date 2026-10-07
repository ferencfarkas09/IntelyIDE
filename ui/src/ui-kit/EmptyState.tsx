import type { LucideIcon } from "lucide-solid";
import { Show, type JSX } from "solid-js";
import { Icon } from "./Icon";

export interface EmptyStateProps {
  icon?: LucideIcon;
  /** Replaces the icon chip, e.g. the BrandMark on a first-run state. */
  visual?: JSX.Element;
  title: string;
  /** One clear sentence. */
  description?: string;
  /** Usually a single Button. */
  action?: JSX.Element;
  tone?: "neutral" | "danger";
  size?: "md" | "sm";
  class?: string;
}

export function EmptyState(props: EmptyStateProps) {
  return (
    <div class={props.class ? `ui-empty ${props.class}` : "ui-empty"} data-tone={props.tone ?? "neutral"} data-size={props.size ?? "md"} role={props.tone === "danger" ? "alert" : undefined}>
      <Show when={props.visual}>
        <span class="ui-empty__visual">{props.visual}</span>
      </Show>
      <Show when={!props.visual && props.icon}>
        {(i) => (
          <span class="ui-empty__icon">
            <Icon icon={i()} size={props.size === "sm" ? 16 : 20} />
          </span>
        )}
      </Show>
      <div class="ui-empty__title">{props.title}</div>
      <Show when={props.description}>
        <p class="ui-empty__desc">{props.description}</p>
      </Show>
      <Show when={props.action}>
        <div class="ui-empty__action">{props.action}</div>
      </Show>
    </div>
  );
}
