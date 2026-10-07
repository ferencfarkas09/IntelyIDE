import type { LucideIcon } from "lucide-solid";
import { For, onMount, Show, type JSX } from "solid-js";
import { Check } from "./icons";
import { Icon } from "./Icon";
import { Kbd } from "./Kbd";
import { Popover, type PopoverApi, type PopoverTriggerProps } from "./Popover";
import type { Placement } from "./position";

export type MenuEntry =
  | {
      type?: "item";
      label: string;
      icon?: LucideIcon;
      shortcut?: string[];
      disabled?: boolean;
      danger?: boolean;
      /** Set to make this a checkable item (aria-checked). */
      checked?: boolean;
      /** With `checked`: one of a group of exclusive choices (`menuitemradio` instead of `menuitemcheckbox`). */
      radio?: boolean;
      description?: string;
      onSelect: () => void;
    }
  | { type: "separator" }
  | { type: "label"; label: string };

export interface MenuProps {
  items: MenuEntry[];
  trigger: (props: PopoverTriggerProps) => JSX.Element;
  placement?: Placement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  "aria-label"?: string;
  /** Extra class on the popover panel (sizing, scrolling). */
  class?: string;
}

const ITEM = '[role^="menuitem"]:not([aria-disabled="true"])';

function MenuList(props: { items: MenuEntry[]; api: PopoverApi; label?: string }) {
  let list!: HTMLDivElement;
  let typed = "";
  let typedTimer: ReturnType<typeof setTimeout> | undefined;
  const enabled = () => [...list.querySelectorAll<HTMLElement>(ITEM)];
  const move = (to: number | "first" | "last" | "next" | "prev") => {
    const els = enabled();
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    const idx = to === "first" ? 0 : to === "last" ? els.length - 1 : to === "next" ? (i + 1) % els.length : to === "prev" ? (i <= 0 ? els.length - 1 : i - 1) : to;
    els[idx].focus();
  };
  onMount(() => (props.api.viaKeyboard() ? move("first") : list.focus()));

  const onKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); return move("next");
      case "ArrowUp": e.preventDefault(); return move("prev");
      case "Home": e.preventDefault(); return move("first");
      case "End": e.preventDefault(); return move("last");
      case "Tab": return props.api.close();
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== " ") {
      typed += e.key.toLowerCase();
      clearTimeout(typedTimer);
      typedTimer = setTimeout(() => (typed = ""), 600);
      const match = enabled().find((el) => el.textContent?.trim().toLowerCase().startsWith(typed));
      match?.focus();
    }
  };

  return (
    <div ref={list} class="ui-menu" tabIndex={-1} onKeyDown={onKeyDown}>
      <For each={props.items}>
        {(entry) => {
          if (entry.type === "separator") return <div class="ui-menu__sep" role="separator" />;
          if (entry.type === "label") return <div class="ui-menu__label" role="presentation">{entry.label}</div>;
          const checkable = entry.checked !== undefined;
          return (
            <button
              type="button"
              class="ui-menu__item"
              role={checkable ? (entry.radio ? "menuitemradio" : "menuitemcheckbox") : "menuitem"}
              aria-checked={checkable ? entry.checked : undefined}
              aria-disabled={entry.disabled ? "true" : undefined}
              data-danger={entry.danger ? "" : undefined}
              tabIndex={-1}
              onPointerMove={(e) => !entry.disabled && e.currentTarget !== document.activeElement && e.currentTarget.focus()}
              onClick={() => {
                if (entry.disabled) return;
                props.api.close();
                entry.onSelect();
              }}
            >
              <span class="ui-menu__lead">
                <Show when={entry.icon ?? (checkable && entry.checked)}>{entry.icon ? <Icon icon={entry.icon} size={14} /> : <Icon icon={Check} size={14} />}</Show>
              </span>
              <span class="ui-menu__text">
                <span class="ui-menu__title">{entry.label}</span>
                <Show when={entry.description}>
                  <span class="ui-menu__desc">{entry.description}</span>
                </Show>
              </span>
              <Show when={entry.shortcut}>
                <Kbd keys={entry.shortcut} />
              </Show>
              <Show when={checkable && entry.checked && entry.icon}>
                <Icon icon={Check} size={14} class="ui-menu__check" />
              </Show>
            </button>
          );
        }}
      </For>
    </div>
  );
}

export function Menu(props: MenuProps) {
  return (
    <Popover kind="menu" trigger={props.trigger} placement={props.placement} open={props.open} onOpenChange={props.onOpenChange} aria-label={props["aria-label"]} class={props.class} gap={6}>
      {(api) => <MenuList items={props.items} api={api} />}
    </Popover>
  );
}
