import { ChevronRight } from "./icons";
import { Show, splitProps, type JSX } from "solid-js";
import { Icon } from "./Icon";
import "./modality";

/** Container for TreeRows: gives the selected row its "active" tint only while the tree has focus. */
export interface TreeProps extends JSX.HTMLAttributes<HTMLDivElement> {
  "aria-label": string;
  multiselectable?: boolean;
  ref?: (el: HTMLDivElement) => void;
}

export function Tree(props: TreeProps) {
  const [local, rest] = splitProps(props, ["multiselectable", "class", "children"]);
  return (
    <div {...rest} role="tree" class={local.class ? `ui-tree ${local.class}` : "ui-tree"} aria-multiselectable={local.multiselectable}>
      {local.children}
    </div>
  );
}

export interface TreeRowProps extends Omit<JSX.HTMLAttributes<HTMLDivElement>, "children"> {
  /** 0-based nesting level; drives indent and indent guides. */
  depth?: number;
  /** undefined = leaf (no chevron), true/false = expandable. */
  expanded?: boolean;
  selected?: boolean;
  /** Keyboard cursor (roving focus or aria-activedescendant target). */
  cursor?: boolean;
  /** Receives Tab focus (roving tabindex = 0). */
  tabbable?: boolean;
  disabled?: boolean;
  /** 22 px rows instead of 24 px. */
  compact?: boolean;
  guides?: boolean;
  onToggle?: () => void;
  /** Before the main content: checkbox, status letter, badge. */
  leading?: JSX.Element;
  /** Always-visible end content: counts, pills. */
  trailing?: JSX.Element;
  /** End content shown on hover and keyboard focus (action buttons). */
  actions?: JSX.Element;
  children?: JSX.Element;
}

export function TreeRow(props: TreeRowProps) {
  const [local, rest] = splitProps(props, [
    "depth", "expanded", "selected", "cursor", "tabbable", "disabled", "compact", "guides", "onToggle", "leading", "trailing", "actions", "children", "class", "style",
  ]);
  const depth = () => local.depth ?? 0;
  return (
    <div
      {...rest}
      role="treeitem"
      class={local.class ? `ui-tree-row ${local.class}` : "ui-tree-row"}
      style={{ "--depth": depth(), ...(typeof local.style === "object" ? local.style : {}) }}
      data-compact={local.compact ? "" : undefined}
      data-selected={local.selected ? "" : undefined}
      data-cursor={local.cursor ? "" : undefined}
      data-has-actions={local.actions ? "" : undefined}
      data-disabled={local.disabled ? "" : undefined}
      aria-level={depth() + 1}
      aria-expanded={local.expanded}
      aria-selected={local.selected ?? false}
      aria-disabled={local.disabled ? "true" : undefined}
      tabIndex={local.tabbable ? 0 : -1}
    >
      <Show when={local.guides !== false && depth() > 0}>
        <span class="ui-tree-row__guides" aria-hidden="true" />
      </Show>
      <span
        class="ui-tree-row__chevron"
        data-expandable={local.expanded === undefined ? undefined : ""}
        data-open={local.expanded ? "" : undefined}
        aria-hidden="true"
        onClick={(e) => {
          if (local.expanded === undefined) return;
          e.stopPropagation();
          local.onToggle?.();
        }}
      >
        <Show when={local.expanded !== undefined}>
          <Icon icon={ChevronRight} size={12} />
        </Show>
      </span>
      <Show when={local.leading}>
        <span class="ui-tree-row__leading">{local.leading}</span>
      </Show>
      <span class="ui-tree-row__main ui-truncate">{local.children}</span>
      <Show when={local.trailing}>
        <span class="ui-tree-row__trailing">{local.trailing}</span>
      </Show>
      <Show when={local.actions}>
        <span class="ui-tree-row__actions">{local.actions}</span>
      </Show>
    </div>
  );
}
