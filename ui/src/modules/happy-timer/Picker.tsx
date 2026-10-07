import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { Trackable } from "../../ipc/happy";
import { timerView } from "../../store/happy";
import { Button, EmptyState, Input, Play, Plus, Search, Skeleton, Spinner, StatusDot, TriangleAlert } from "../../ui-kit";
import { groupSearch, groupTrackables, isTarget, knownProjects } from "./logic";
import { NewTask } from "./NewTask";
import "./timer.css";

/** How long typing pauses before the server is asked. */
export const SEARCH_DEBOUNCE_MS = 250;

interface Group {
  key: string;
  title: string;
  customer?: string;
  projectId?: string;
  items: Trackable[];
}

/**
 * The task picker: the quick-start tasks of the summary, a search box that asks the server (debounced) for projects and
 * tasks while the quick-start rows filter instantly, and an inline "New task" under each project.
 */
export function Picker(props: { busy: boolean; onPick: (item: Trackable) => void }) {
  const [query, setQuery] = createSignal("");
  const [term, setTerm] = createSignal("");
  const [creating, setCreating] = createSignal<string>();
  const [trackables, { refetch }] = createResource(() => ipc.happy.timer.trackables());
  const [search] = createResource(term, (q) => (q ? ipc.happy.timer.search(q) : undefined));
  let list!: HTMLDivElement;
  let input!: HTMLInputElement;

  // Debounce: the server is asked for the trimmed text once typing pauses; clearing the box clears at once.
  createEffect(
    on(query, (q) => {
      const next = q.trim();
      if (!next) return setTerm("");
      const id = setTimeout(() => setTerm(next), SEARCH_DEBOUNCE_MS);
      onCleanup(() => clearTimeout(id));
    }),
  );

  const typed = () => query().trim();
  const quick = () => (trackables.state === "ready" || trackables.state === "refreshing" ? (trackables() ?? []) : []);
  const found = () => (search.state === "ready" || search.state === "refreshing" ? search() : undefined);
  /** The server answered for exactly what is typed now. */
  const answered = () => !!typed() && term() === typed() && !search.loading && search.state === "ready";
  const failed = () => !!typed() && term() === typed() && search.state === "errored";
  const waiting = () => !!typed() && !answered() && !failed();

  const groups = (): Group[] => {
    const q = typed();
    const local = groupTrackables(quick(), q).map((g) => ({ key: `q:${g.project}`, title: g.project, projectId: g.projectId, items: g.items }));
    if (!q) return local;
    const result = found();
    if (!answered() || !result) return local;
    const orders = groupTrackables(quick().filter((i) => i.kind === "workOrder"), q).map((g) => ({ key: `w:${g.project}`, title: g.project, items: g.items }));
    return [...orders, ...groupSearch(result).map((g) => ({ key: `s:${g.projectId}`, title: g.project, customer: g.customer, projectId: g.projectId, items: g.items }))];
  };

  const created = (task: Trackable) => {
    setCreating(undefined);
    setQuery("");
    props.onPick(task);
    void refetch();
  };

  const options = () => [...list.querySelectorAll<HTMLElement>(".ht__option:not(:disabled)")];
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const all = options();
    const at = all.indexOf(document.activeElement as HTMLElement);
    if (e.target === input) {
      if (e.key === "ArrowUp" || !all.length) return;
      e.preventDefault();
      return all[0].focus();
    }
    e.preventDefault();
    const next = at + (e.key === "ArrowDown" ? 1 : -1);
    if (next < 0) return input.focus();
    all[Math.min(next, all.length - 1)]?.focus();
  };

  return (
    <div class="ht__picker" onKeyDown={onKeyDown}>
      <Input
        ref={input}
        size="sm"
        value={query()}
        placeholder={t("htm.search")}
        aria-label={t("htm.search")}
        leading={<Search size={12} />}
        trailing={waiting() || search.loading ? <Spinner size={12} /> : undefined}
        onInput={(e) => setQuery(e.currentTarget.value)}
      />
      <div class="ht__list" role="listbox" aria-label={t("htm.list")} aria-busy={waiting() || trackables.loading ? "true" : undefined} ref={list}>
        <Show when={!trackables.loading || trackables()} fallback={<><Skeleton height={28} /><Skeleton height={28} /><Skeleton height={28} /></>}>
          <Show
            when={!trackables.error}
            fallback={<EmptyState size="sm" tone="danger" icon={TriangleAlert} title={t("htm.listFailed")} description={(trackables.error as { message?: string })?.message} action={<Button size="sm" onClick={() => void refetch()}>{t("hx.retry")}</Button>} />}
          >
            <Show when={failed()}>
              <p class="ht__hint ht__notice" role="status">{t("htm.searchFailed")}</p>
            </Show>
            <For each={groups()}>
              {(g) => (
                <section class="ht__group" aria-label={g.title}>
                  <h5 class="ht__group-title">
                    <span class="ui-truncate">{g.title}</span>
                    <Show when={g.customer}><span class="ht__group-sub ui-truncate">{g.customer}</span></Show>
                  </h5>
                  <For each={g.items}>
                    {(item) => (
                      <button type="button" role="option" class="ht__option" aria-selected={isTarget(timerView(), item)} disabled={props.busy} onClick={() => props.onPick(item)}>
                        <span class="ht__option-title">{item.title}</span>
                        <Show when={isTarget(timerView(), item)} fallback={<Play size={12} />}><StatusDot tone="ok" size={6} /></Show>
                      </button>
                    )}
                  </For>
                  <Show when={g.projectId && !g.items.length && !creating()}>
                    <p class="ht__hint ht__group-empty">{t("htm.noTasksInProject")}</p>
                  </Show>
                  <Show when={g.projectId}>
                    {(id) => (
                      <Show
                        when={creating() === g.key}
                        fallback={<button type="button" class="ht__option ht__option--action" disabled={props.busy} onClick={() => setCreating(g.key)} aria-label={t("htm.new.in", { project: g.title })}><span class="ht__option-title">{t("htm.new.row")}</span><Plus size={12} /></button>}
                      >
                        <NewTask projectId={id()} projectTitle={g.title} projects={[]} onCreated={created} onCancel={() => setCreating(undefined)} />
                      </Show>
                    )}
                  </Show>
                </section>
              )}
            </For>
            <Show when={!groups().length && !waiting()}>
              <p class="ht__hint">{typed() ? t("htm.noMatch") : t("htm.noTasks")}</p>
              <Show when={typed()}>
                <Show
                  when={creating() === "free"}
                  fallback={<button type="button" class="ht__option ht__option--action" disabled={props.busy} onClick={() => setCreating("free")}><span class="ht__option-title">{t("htm.new.createFor", { title: typed() })}</span><Plus size={12} /></button>}
                >
                  <NewTask initialTitle={typed()} projects={knownProjects(quick(), found())} onCreated={created} onCancel={() => setCreating(undefined)} />
                </Show>
              </Show>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  );
}
