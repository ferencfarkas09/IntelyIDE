import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { Check, Icon, Input, Search } from "../../ui-kit";
import { isReviewed, languageName, locale, nameOf, pickerLanguages, t, type Locale } from "../../i18n";
import "./language.css";

/** Does `query` match the language by its own name, the English name, the current-language name or the code? */
export function matchesLanguage(code: string, query: string, current: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return true;
  return [code, languageName(code), languageName(code, "en"), languageName(code, current)].some((s) => s.toLocaleLowerCase().includes(q));
}

/** Searchable list of every shipped language, each in its own script. Arrow keys move, Enter picks. */
export function LanguagePicker(props: { onPick: (code: Locale) => void }) {
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(-1);
  const items = createMemo(() => pickerLanguages().filter((l) => matchesLanguage(l.code, query(), locale())));
  let list: HTMLUListElement | undefined;
  // Open on the current language, not at the top of 50.
  onMount(() => {
    const current = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (list && current) list.scrollTop = Math.max(0, current.offsetTop - list.clientHeight / 2 + current.offsetHeight / 2);
  });

  const move = (step: number) => {
    const n = items().length;
    if (!n) return;
    const next = (active() + step + n) % n;
    setActive(next);
    queueMicrotask(() => list?.querySelector(`[data-index="${next}"]`)?.scrollIntoView?.({ block: "nearest" }));
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") (e.preventDefault(), move(1));
    else if (e.key === "ArrowUp") (e.preventDefault(), move(-1));
    else if (e.key === "Enter" && !e.isComposing) {
      const pick = items()[active()] ?? (items().length === 1 ? items()[0] : undefined);
      if (pick) (e.preventDefault(), props.onPick(pick.code));
    }
  };

  return (
    <div class="lang" onKeyDown={onKeyDown}>
      <Input
        size="sm"
        aria-label={t("general.languageSearch")}
        placeholder={t("general.languageSearch")}
        autocomplete="off"
        spellcheck={false}
        leading={<Icon icon={Search} size={14} />}
        value={query()}
        onInput={(e) => (setQuery(e.currentTarget.value), setActive(-1))}
      />
      <ul class="lang__list" ref={list} role="listbox" aria-label={t("general.language")}>
        <For each={items()} fallback={<li class="lang__none" role="presentation">{t("general.languageNone")}</li>}>
          {(l, i) => (
            <li
              class="lang__item"
              role="option"
              data-index={i()}
              data-active={active() === i() ? "" : undefined}
              aria-selected={locale() === l.code}
              lang={l.code}
              dir={l.rtl ? "rtl" : undefined}
              onPointerMove={() => setActive(i())}
              onClick={() => props.onPick(l.code)}
            >
              <span class="lang__name ui-truncate">{nameOf(l.code)}</span>
              <Show when={l.code !== "en" && nameOf(l.code, true) !== nameOf(l.code)}>
                <span class="lang__sub ui-truncate" lang={locale()} dir="auto">{nameOf(l.code, true)}</span>
              </Show>
              <Show when={!isReviewed(l.code) && !l.pseudo}>
                <span class="lang__mt" title={t("general.machineNotice")} aria-hidden="true">MT</span>
              </Show>
              <Show when={locale() === l.code}>
                <Check size={14} class="lang__check" aria-hidden="true" />
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
