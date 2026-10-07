// Multi-select people picker over the directory: a field with the chosen people as removable chips and a listbox of matches.
import { createEffect, createSignal, createUniqueId, For, on, Show } from "solid-js";
import { t } from "../../i18n";
import type { ChatPerson } from "../../ipc/happy";
import { happyStatus } from "../../store/happy";
import { announce, Button, Icon, Search, Skeleton, X } from "../../ui-kit";
import "./chat-dialogs.css";
import { createDebounced } from "./dialogs-logic";
import { Avatar } from "./Message";
import { searchPeople } from "./state";

export interface PeoplePickerProps {
  selected: ChatPerson[];
  onChange: (next: ChatPerson[]) => void;
  /** Person ids that cannot be picked (current members). */
  exclude?: readonly string[];
  /** At most this many people can be chosen. */
  max?: number;
  /** Accessible name of the field and the list. */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  /** Focuses the field first when it sits in a dialog. */
  autofocus?: boolean;
}

type Status = "loading" | "ok" | "error";

export function PeoplePicker(props: PeoplePickerProps) {
  const listId = createUniqueId();
  const [query, setQuery] = createSignal("");
  const q = createDebounced(query, 180);
  const [people, setPeople] = createSignal<ChatPerson[]>([]);
  const [status, setStatus] = createSignal<Status>("loading");
  const [active, setActive] = createSignal(0);
  let run = 0;
  let input!: HTMLInputElement;
  let list: HTMLUListElement | undefined;

  const load = (text: string) => {
    const id = ++run;
    setStatus("loading");
    searchPeople(text.trim()).then(
      (r) => id === run && (setPeople(r), setStatus("ok")),
      () => id === run && setStatus("error"),
    );
  };
  createEffect(on(q, load));

  const atMax = () => props.max !== undefined && props.selected.length >= props.max;
  const options = () => {
    const skip = new Set([...(props.exclude ?? []), ...props.selected.map((p) => p.id)]);
    const self = happyStatus()?.user?.id;
    if (self) skip.add(self);
    return people().filter((p) => !skip.has(p.id));
  };
  createEffect(on(options, () => setActive(0)));
  createEffect(() => {
    const el = list?.children[active()] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: "nearest" });
  });

  const pick = (p: ChatPerson) => {
    if (props.disabled || atMax()) return;
    props.onChange([...props.selected, p]);
    setQuery("");
    announce(t("hc.dlg.picker.added", { name: p.name }));
    input.focus();
  };
  const unpick = (p: ChatPerson) => {
    props.onChange(props.selected.filter((s) => s.id !== p.id));
    announce(t("hc.dlg.picker.removed", { name: p.name }));
    input.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const n = options().length;
    if (e.key === "ArrowDown" && n) {
      e.preventDefault();
      setActive((i) => (i + 1) % n);
    } else if (e.key === "ArrowUp" && n) {
      e.preventDefault();
      setActive((i) => (i - 1 + n) % n);
    } else if (e.key === "Enter") {
      const p = options()[active()];
      if (p && !atMax()) {
        e.preventDefault();
        e.stopPropagation();
        pick(p);
      }
    } else if (e.key === "Backspace" && !query() && props.selected.length) {
      unpick(props.selected[props.selected.length - 1]!);
    }
  };

  return (
    <div class="hcd-picker">
      <div class="ui-input hcd-picker__field" data-size="md" data-disabled={props.disabled ? "" : undefined}>
        <Icon icon={Search} size={14} class="hcd-picker__icon" />
        <ul class="hcd-chips" aria-label={t("hc.dlg.picker.selected", { count: props.selected.length })}>
          <For each={props.selected}>
            {(p) => (
              <li class="hcd-chip">
                <span class="hcd-chip__name ui-truncate">{p.name}</span>
                <button type="button" class="hcd-chip__x" aria-label={t("hc.dlg.picker.remove", { name: p.name })} disabled={props.disabled} onClick={() => unpick(p)}>
                  <Icon icon={X} size={12} />
                </button>
              </li>
            )}
          </For>
        </ul>
        <input
          ref={input}
          class="ui-input__field hcd-picker__input"
          type="text"
          role="combobox"
          aria-label={props.label}
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={options().length && !atMax() ? `${listId}-${active()}` : undefined}
          placeholder={props.selected.length ? "" : (props.placeholder ?? t("hc.dlg.picker.placeholder"))}
          autocomplete="off"
          spellcheck={false}
          data-autofocus={props.autofocus ? "" : undefined}
          disabled={props.disabled}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <Show when={props.max !== undefined}>
        <p class="hcd-hint" data-over={atMax() ? "" : undefined}>
          {atMax() ? t("hc.dlg.picker.maxReached", { max: props.max! }) : t("hc.dlg.picker.count", { count: props.selected.length, max: props.max! })}
        </p>
      </Show>
      <div class="hcd-picker__results">
        <Show when={status() === "error"}>
          <div class="hcd-state" role="alert">
            <span>{t("hc.dlg.picker.error")}</span>
            <Button size="sm" variant="secondary" onClick={() => load(q())}>{t("hc.dlg.retry")}</Button>
          </div>
        </Show>
        <Show when={status() === "loading" && !people().length}>
          <div class="hcd-skel" aria-hidden="true">
            <Skeleton height={34} />
            <Skeleton height={34} />
            <Skeleton height={34} />
          </div>
        </Show>
        <Show when={status() === "ok" && !options().length}>
          <p class="hcd-state" role="status">{q().trim() ? t("hc.dlg.picker.none", { query: q().trim() }) : t("hc.dlg.picker.noneLeft")}</p>
        </Show>
        <Show when={status() !== "error" && options().length && !atMax()}>
          <ul ref={list} id={listId} class="hcd-options" role="listbox" aria-label={props.label} aria-busy={status() === "loading"}>
            <For each={options()}>
              {(p, i) => (
                <li
                  id={`${listId}-${i()}`}
                  class="hcd-option"
                  role="option"
                  aria-selected={active() === i()}
                  data-active={active() === i() ? "" : undefined}
                  onPointerMove={() => setActive(i())}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(p)}
                >
                  <Avatar name={p.name} size={24} />
                  <span class="hcd-option__text">
                    <span class="hcd-option__name ui-truncate">{p.name}</span>
                    <Show when={p.detail}>
                      <span class="hcd-option__detail ui-truncate">{p.detail}</span>
                    </Show>
                  </span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>
    </div>
  );
}
