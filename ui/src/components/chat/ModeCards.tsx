import { createUniqueId, For, Show } from "solid-js";
import { t } from "../../i18n";
import type { PermissionMode } from "../../store/agent-types";
import { Icon } from "../../ui-kit";
import { MODE_META, MODE_ORDER } from "./modes";
import "./modes.css";

export interface ModeCardsProps {
  /** The modes to show; they are laid out in policy order whatever the order given. */
  modes: readonly PermissionMode[];
  value: PermissionMode | undefined;
  onChange: (mode: PermissionMode) => void;
  /** The group's accessible name: an element id (a legend) or a plain label. */
  labelledBy?: string;
  label?: string;
  /** A mode that cannot be picked, with the reason (shown as its tooltip and in its description). */
  unavailable?: Partial<Record<PermissionMode, string>>;
  /** Modes that open a confirmation when picked: announced as such, and arrow keys move over them without picking them. */
  confirm?: readonly PermissionMode[];
  /** `grid`: the New run dialog (wide); `list`: one column, for the chat column. */
  layout?: "grid" | "list";
  disabled?: boolean;
  class?: string;
}

/**
 * The five run modes as a radio group of option cards: icon, name and the one-line explanation. One tab stop (the picked card),
 * arrows move and pick (arrows only move over a mode that needs confirming), Space and Enter pick.
 */
export function ModeCards(props: ModeCardsProps) {
  const uid = createUniqueId();
  const shown = () => MODE_ORDER.filter((m) => props.modes.includes(m));
  const reasonOf = (m: PermissionMode) => props.unavailable?.[m];
  const pickable = (m: PermissionMode) => !props.disabled && !reasonOf(m);
  // Tab enters on the picked card, or the first one that can be picked when none is.
  const tabbable = (m: PermissionMode) => (props.value !== undefined && shown().includes(props.value) ? m === props.value : m === shown().find(pickable));
  let group: HTMLDivElement | undefined;
  const onKey = (e: KeyboardEvent, m: PermissionMode) => {
    const step = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const ok = shown().filter(pickable);
    if (!ok.length) return;
    const next = ok[(Math.max(0, ok.indexOf(m)) + step + ok.length) % ok.length];
    group?.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus();
    if (!props.confirm?.includes(next)) props.onChange(next);
  };
  return (
    <div ref={group} class={props.class ? `mode-cards ${props.class}` : "mode-cards"} data-layout={props.layout ?? "grid"} role="radiogroup" aria-labelledby={props.labelledBy} aria-label={props.labelledBy ? undefined : props.label}>
      <For each={shown()}>
        {(m) => {
          const meta = MODE_META[m];
          const hint = `${uid}-${m}`;
          return (
            <button
              type="button"
              class="mode-card"
              role="radio"
              data-mode={m}
              data-tone={meta.tone}
              aria-checked={props.value === m}
              aria-disabled={!pickable(m) ? "true" : undefined}
              aria-describedby={hint}
              aria-haspopup={props.confirm?.includes(m) ? "dialog" : undefined}
              tabIndex={tabbable(m) ? 0 : -1}
              title={reasonOf(m) ?? (props.confirm?.includes(m) ? t("modes.picker.bypassOpens") : undefined)}
              onClick={() => pickable(m) && props.onChange(m)}
              onKeyDown={(e) => onKey(e, m)}
            >
              <span class="mode-card__head">
                <Icon icon={meta.icon} size={14} />
                <span class="mode-card__label">{t(meta.label)}</span>
              </span>
              <span class="mode-card__hint" id={hint}>
                {t(meta.hint)}
                <Show when={reasonOf(m)}>{(why) => <span class="mode-card__why"> {why()}</span>}</Show>
              </span>
            </button>
          );
        }}
      </For>
    </div>
  );
}
