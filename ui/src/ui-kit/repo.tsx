import { ArrowDown, ArrowUp, GitBranch } from "./icons";
import { Show } from "solid-js";
import { Icon } from "./Icon";
import { splitMiddle } from "./middle";
import { Tooltip } from "./Tooltip";

export interface RepoBadgeProps {
  /** Repo colour, #rrggbb. Used only for this small badge and dots. */
  color: string;
  /** 1-2 characters. */
  badge: string;
  size?: 16 | 20 | 24;
  title?: string;
  class?: string;
}

/** Rounded square with initials in the repo colour. */
export function RepoBadge(props: RepoBadgeProps) {
  return (
    <span
      class={props.class ? `ui-repo-badge ${props.class}` : "ui-repo-badge"}
      data-size={props.size ?? 20}
      style={{ "--rc": props.color }}
      title={props.title}
      aria-hidden={props.title ? undefined : "true"}
    >
      {props.badge.slice(0, 2)}
    </span>
  );
}

/** Text that, when it must shrink, loses its middle instead of its end. The full text is for the tooltip of the parent. */
export function MiddleEllipsis(props: { text: string; class?: string }) {
  const parts = () => splitMiddle(props.text);
  return (
    <span class={props.class ? `ui-mid ${props.class}` : "ui-mid"}>
      <span class="ui-mid__head">{parts()[0]}</span>
      <Show when={parts()[1]}>
        <span class="ui-mid__tail">{parts()[1]}</span>
      </Show>
    </span>
  );
}

export interface BranchPillProps {
  name?: string;
  detached?: boolean;
  unborn?: boolean;
  /** Short oid shown when detached. */
  oid?: string;
  /** Remote-tracking branch (`origin/main`), shown in the tooltip after the full name. */
  upstream?: string;
  class?: string;
}

/** The pill may shorten the name; the tooltip always carries the full name and the remote. */
export function BranchPill(props: BranchPillProps) {
  const text = () => (props.unborn ? "no commits yet" : props.detached ? `detached${props.oid ? " " + props.oid : ""}` : (props.name ?? "(unknown)"));
  const tip = () => (
    <span class="ui-branch-tip">
      <span class="ui-branch-tip__name">{props.name ?? text()}</span>
      <Show when={props.name && !props.detached && !props.unborn && props.upstream}>
        <span class="ui-branch-tip__remote">→ {props.upstream}</span>
      </Show>
    </span>
  );
  return (
    <Tooltip label={tip()} placement="bottom">
      <span class={props.class ? `ui-branch ${props.class}` : "ui-branch"} data-muted={props.detached || props.unborn ? "" : undefined}>
        <Icon icon={GitBranch} size={12} />
        <MiddleEllipsis class="ui-branch__name" text={text()} />
      </span>
    </Tooltip>
  );
}

export interface AheadBehindProps {
  ahead: number;
  behind: number;
  class?: string;
}

/** Commits ahead of / behind the upstream. Renders nothing when in sync. */
export function AheadBehind(props: AheadBehindProps) {
  return (
    <Show when={props.ahead > 0 || props.behind > 0}>
      <span
        class={props.class ? `ui-ab ui-tnum ${props.class}` : "ui-ab ui-tnum"}
        role="img"
        aria-label={`${props.ahead} ahead, ${props.behind} behind`}
      >
        <Show when={props.ahead > 0}>
          <span class="ui-ab__ahead">
            <Icon icon={ArrowUp} size={12} />
            {props.ahead}
          </span>
        </Show>
        <Show when={props.behind > 0}>
          <span class="ui-ab__behind">
            <Icon icon={ArrowDown} size={12} />
            {props.behind}
          </span>
        </Show>
      </span>
    </Show>
  );
}
