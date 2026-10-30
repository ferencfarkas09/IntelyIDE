import { createMemo, createSignal, For, Index, Show } from "solid-js";
import { t } from "../../i18n";
import { repoConfig } from "../../store/workspace";
import { Badge, EmptyState, Icon, Input, ListChecks, Search } from "../../ui-kit";
import { searchPrompts } from "./logic";
import type { ScopedPrompt } from "./types";

export const scopeLabel = (p: ScopedPrompt): string =>
  p.scope.kind === "starter" ? t("prompts.scope.starter") : p.scope.kind === "user" ? t("prompts.scope.user") : t("prompts.scope.repo", { repo: repoConfig(p.scope.repoId)?.name ?? p.scope.repoId });

/** A search box over the prompts and the matching ones as a list; Enter picks the first match. Rows are kept by position, so a reload of the library does not replace the focused one. */
export function PromptList(props: { prompts: readonly ScopedPrompt[]; onPick: (p: ScopedPrompt) => void; selected?: string; autofocus?: boolean; class?: string }) {
  const [query, setQuery] = createSignal("");
  const shown = createMemo(() => searchPrompts(props.prompts, query()));
  return (
    <div class={`prompts-list ${props.class ?? ""}`}>
      <Input
        size="sm"
        data-autofocus={props.autofocus ? "" : undefined}
        aria-label={t("prompts.search")}
        placeholder={t("prompts.search")}
        leading={<Icon icon={Search} size={12} />}
        value={query()}
        onInput={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => e.key === "Enter" && shown()[0] && (e.preventDefault(), props.onPick(shown()[0]))}
      />
      <Show when={shown().length > 0} fallback={<EmptyState size="sm" icon={ListChecks} title={t("prompts.noMatch")} />}>
        <ul class="prompts-list__items" aria-label={t("prompts.listAria")}>
          <Index each={shown()}>
            {(p) => (
              <li>
                <button type="button" class="prompts-list__item" aria-current={props.selected === p().id ? "true" : undefined} onClick={() => props.onPick(p())}>
                  <span class="prompts-list__title ui-truncate">{p().title}</span>
                  <span class="prompts-list__meta">
                    <Badge size="sm" tone={p().scope.kind === "starter" ? "neutral" : "accent"}>{scopeLabel(p())}</Badge>
                    <For each={p().tags.slice(0, 3)}>{(tag) => <span class="prompts-list__tag">#{tag}</span>}</For>
                  </span>
                </button>
              </li>
            )}
          </Index>
        </ul>
      </Show>
    </div>
  );
}
