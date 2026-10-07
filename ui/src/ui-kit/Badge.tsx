import type { LucideIcon } from "lucide-solid";
import { Show, splitProps, type JSX } from "solid-js";
import { Icon } from "./Icon";

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "info";

export interface BadgeProps {
  tone?: Tone;
  variant?: "subtle" | "solid" | "outline";
  size?: "sm" | "md";
  icon?: LucideIcon;
  /** Use for counts: tabular digits. */
  numeric?: boolean;
  title?: string;
  class?: string;
  children?: JSX.Element;
}

/** Small rectangular label or count. */
export function Badge(props: BadgeProps) {
  return (
    <span
      class={props.class ? `ui-badge ${props.class}` : "ui-badge"}
      data-tone={props.tone ?? "neutral"}
      data-variant={props.variant ?? "subtle"}
      data-size={props.size ?? "md"}
      classList={{ "ui-tnum": props.numeric }}
      title={props.title}
    >
      <Show when={props.icon}>{(i) => <Icon icon={i()} size={12} />}</Show>
      {props.children}
    </span>
  );
}

export interface PillProps {
  tone?: Tone;
  size?: "sm" | "md";
  leading?: JSX.Element;
  trailing?: JSX.Element;
  /** Renders a button when set. */
  onClick?: (e: MouseEvent) => void;
  selected?: boolean;
  title?: string;
  "aria-label"?: string;
  /** Extra attributes for the button variant, e.g. a Popover trigger's ref and aria-expanded. */
  buttonProps?: JSX.ButtonHTMLAttributes<HTMLButtonElement>;
  class?: string;
  children?: JSX.Element;
}

/** Fully rounded container for compound status (repo + branch + ahead/behind). */
export function Pill(props: PillProps) {
  const [local] = splitProps(props, ["leading", "trailing", "children"]);
  const content = (
    <>
      {local.leading}
      <Show when={local.children !== undefined}>
        <span class="ui-pill__text">{local.children}</span>
      </Show>
      {local.trailing}
    </>
  );
  // Getters, so a spread keeps following the props.
  const common = {
    get class() {
      return props.class ? `ui-pill ${props.class}` : "ui-pill";
    },
    get "data-tone"() {
      return props.tone ?? "neutral";
    },
    get "data-size"() {
      return props.size ?? "md";
    },
    get title() {
      return props.title;
    },
    get "aria-label"() {
      return props["aria-label"];
    },
  };
  return props.onClick ? (
    <button type="button" {...props.buttonProps} {...common} aria-pressed={props.selected} data-selected={props.selected ? "" : undefined} onClick={props.onClick}>
      {content}
    </button>
  ) : (
    <span {...common} data-selected={props.selected ? "" : undefined}>
      {content}
    </span>
  );
}

export type StatusTone = "neutral" | "accent" | "ok" | "warn" | "danger" | "info";

export interface StatusDotProps {
  tone?: StatusTone;
  size?: 6 | 8;
  /** Slow pulse for work in progress (disabled with reduced motion). */
  pulse?: boolean;
  /** Text alternative: colour is never the only signal. */
  label?: string;
  class?: string;
}

export function StatusDot(props: StatusDotProps) {
  return (
    <span
      class={props.class ? `ui-dot ${props.class}` : "ui-dot"}
      data-tone={props.tone ?? "neutral"}
      data-size={props.size ?? 8}
      data-pulse={props.pulse ? "" : undefined}
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
    />
  );
}

export type ChangeKindName = "modified" | "added" | "deleted" | "renamed" | "copied" | "typeChanged" | "untracked" | "conflicted" | "submodule";

const LETTERS: Record<ChangeKindName, [string, string]> = {
  modified: ["M", "Modified"],
  added: ["A", "Added"],
  deleted: ["D", "Deleted"],
  renamed: ["R", "Renamed"],
  copied: ["C", "Copied"],
  typeChanged: ["T", "Type changed"],
  untracked: ["U", "Untracked"],
  conflicted: ["!", "Conflicted"],
  submodule: ["S", "Submodule"],
};

/** One-letter change status in its status colour; the letter and its label carry the meaning, not the colour. */
export function StatusLetter(props: { kind: ChangeKindName; class?: string }) {
  return (
    <span class={props.class ? `ui-status-letter ${props.class}` : "ui-status-letter"} data-kind={props.kind} role="img" aria-label={LETTERS[props.kind][1]} title={LETTERS[props.kind][1]}>
      {LETTERS[props.kind][0]}
    </span>
  );
}
