import { createSignal, For, Show } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { Button, Input, Plus, X } from "../../ui-kit";
import { patternProblem, withPattern, withoutPattern, type PatternProblem } from "./patterns";

const PROBLEM_KEY = {
  empty: "patterns.problem.empty",
  spaces: "patterns.problem.spaces",
  duplicate: "patterns.problem.duplicate",
  tooLong: "patterns.problem.tooLong",
} as const satisfies Record<PatternProblem, MessageKey>;

export interface PatternEditorProps {
  /** Accessible name of the list and the field, e.g. "Protected branches". */
  label: string;
  patterns: readonly string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}

/** A removable chip per pattern and one field to add another. Case matters, `*` is a wildcard. */
export function PatternEditor(props: PatternEditorProps) {
  const [draft, setDraft] = createSignal("");
  const [shown, setShown] = createSignal(false);
  const problem = () => (shown() ? patternProblem(props.patterns, draft()) : null);

  function add(e: Event) {
    e.preventDefault();
    setShown(true);
    if (patternProblem(props.patterns, draft())) return;
    props.onChange(withPattern(props.patterns, draft()));
    setDraft("");
    setShown(false);
  }

  return (
    <div class="patterns">
      <ul class="patterns__chips" aria-label={props.label}>
        <For each={props.patterns} fallback={<li class="patterns__none">{t("patterns.none")}</li>}>
          {(pattern) => (
            <li class="patterns__chip">
              <code>{pattern}</code>
              <button type="button" class="patterns__remove" aria-label={t("patterns.remove", { pattern, label: props.label })} onClick={() => props.onChange(withoutPattern(props.patterns, pattern))}>
                <X size={12} />
              </button>
            </li>
          )}
        </For>
      </ul>
      <form class="patterns__add" onSubmit={add}>
        <Input size="sm" aria-label={t("patterns.addTo", { label: props.label })} placeholder={props.placeholder ?? t("patterns.placeholder")} autocomplete="off" spellcheck={false} value={draft()} invalid={!!problem()} onInput={(e) => (setDraft(e.currentTarget.value), setShown(false))} />
        <Button type="submit" size="sm" icon={Plus} disabled={!draft().trim()}>{t("patterns.add")}</Button>
      </form>
      <Show when={problem()}>{(p) => <p class="repolist__problem" role="alert">{t(PROBLEM_KEY[p()])}</p>}</Show>
    </div>
  );
}

/** Read-only list of patterns the backend ships. */
export function PatternChips(props: { label: string; patterns: readonly string[] }) {
  return (
    <ul class="patterns__chips" aria-label={props.label}>
      <For each={props.patterns}>{(p) => <li class="patterns__chip" data-fixed=""><code>{p}</code></li>}</For>
    </ul>
  );
}
