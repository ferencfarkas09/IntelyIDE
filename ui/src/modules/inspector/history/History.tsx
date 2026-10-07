import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { fmtTokens, modelLabel } from "../../../components/chat/format";
import { t } from "../../../i18n";
import { ipc as defaultIpc, type Ipc } from "../../../ipc";
import type { RunSummary } from "../../../ipc/runs";
import type { TabInstance } from "../../../platform/tabs";
import { repoConfig } from "../../../store/workspace";
import { Badge, Button, CircleAlert, EmptyState, History as HistoryIcon, Input, Pill, RepoBadge, SegmentedControl, Search, Skeleton, StatusDot, Tooltip } from "../../../ui-kit";
import { relativeTime } from "../format";
import { openInspector } from "../openers";
import { forkRun, resumeRun } from "../runActions";
import { continueGate, distinctRepos, distinctRoles, filterRuns, isFiltered, NO_FILTER, toggled, type DateRange, type HistoryFilter } from "./logic";
import "./history.css";

const message = (e: unknown): string => (e instanceof Error ? e.message : String((e as { message?: string }).message ?? e));
const STATUS: Record<RunSummary["status"], { tone: "accent" | "ok" | "danger" | "warn"; text: () => string }> = {
  running: { tone: "accent", text: () => t("inspector.hist.running") },
  done: { tone: "ok", text: () => t("inspector.hist.done") },
  failed: { tone: "danger", text: () => t("inspector.hist.statusFailed") },
  cancelled: { tone: "warn", text: () => t("inspector.hist.cancelled") },
};

/** Search and filters outlive the tab component, which remounts whenever the tab is activated. */
const [query, setQuery] = createSignal("");
const [filter, setFilter] = createSignal<HistoryFilter>(NO_FILTER);

export function resetHistoryFilters(): void {
  setQuery("");
  setFilter(NO_FILTER);
}

export default function History(props: { tab?: TabInstance; client?: Ipc }) {
  const client = () => props.client ?? defaultIpc;
  const [runs, setRuns] = createSignal<RunSummary[] | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [busy, setBusy] = createSignal<string | undefined>(undefined);
  const shown = () => filterRuns(runs() ?? [], filter(), Date.now());

  let seq = 0;
  async function load(q: string) {
    const mine = ++seq;
    try {
      const list = await client().runs.history(q.trim() || undefined);
      if (mine === seq) (setRuns(list), setError(undefined));
    } catch (e) {
      if (mine === seq) (setError(message(e)), setRuns([]));
    }
  }
  onMount(() => void load(query()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(on(query, (q) => (clearTimeout(timer), (timer = setTimeout(() => void load(q), 200))), { defer: true }));
  onCleanup(() => clearTimeout(timer));

  const act = async (kind: "resume" | "fork", run: RunSummary) => {
    setBusy(`${kind}:${run.id}`);
    await (kind === "resume" ? resumeRun : forkRun)(run.id, client());
    setBusy(undefined);
  };

  return (
    <section class="hist" aria-label={t("inspector.hist.label")}>
      <header class="hist__bar">
        <Input
          size="sm"
          wrapperClass="hist__search"
          aria-label={t("inspector.hist.search")}
          placeholder={t("inspector.hist.searchPlaceholder")}
          leading={<Search size={14} />}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <SegmentedControl<DateRange>
          size="sm"
          aria-label={t("inspector.hist.range")}
          value={filter().range}
          onChange={(range) => setFilter({ ...filter(), range })}
          options={[
            { value: "all", label: t("inspector.hist.all") },
            { value: "day", label: t("inspector.hist.day") },
            { value: "week", label: t("inspector.hist.week") },
            { value: "month", label: t("inspector.hist.month") },
          ]}
        />
      </header>
      <Show when={(runs()?.length ?? 0) > 0}>
        <div class="hist__chips" role="group" aria-label={t("inspector.hist.filters")}>
          <For each={distinctRepos(runs() ?? [])}>
            {(id) => (
              <Pill size="sm" selected={filter().repos.has(id)} onClick={() => setFilter({ ...filter(), repos: toggled(filter().repos, id) })} leading={<Show when={repoConfig(id)}>{(r) => <RepoBadge color={r().color} badge={r().badge} size={16} />}</Show>}>
                {repoConfig(id)?.name ?? id}
              </Pill>
            )}
          </For>
          <span class="hist__sep" aria-hidden="true" />
          <For each={distinctRoles(runs() ?? [])}>
            {(role) => (
              <Pill size="sm" selected={filter().roles.has(role)} onClick={() => setFilter({ ...filter(), roles: toggled(filter().roles, role) })}>
                {role}
              </Pill>
            )}
          </For>
          <Show when={isFiltered(filter())}>
            <Button size="sm" variant="ghost" onClick={() => setFilter(NO_FILTER)}>{t("inspector.hist.clear")}</Button>
          </Show>
        </div>
      </Show>
      <div class="hist__list">
        <Show when={!error()} fallback={<EmptyState icon={CircleAlert} tone="danger" title={t("inspector.hist.failed")} description={error()} action={<Button onClick={() => void load(query())}>{t("inspector.retry")}</Button>} />}>
          <Show
            when={runs()}
            fallback={
              <div class="hist__loading" aria-busy="true">
                <Skeleton width="100%" height={40} />
                <Skeleton width="100%" height={40} />
                <Skeleton width="100%" height={40} />
              </div>
            }
          >
            <Show
              when={shown().length > 0}
              fallback={
                <EmptyState
                  icon={HistoryIcon}
                  title={query().trim() || isFiltered(filter()) ? t("inspector.hist.noMatch") : t("inspector.hist.noneYet")}
                  description={query().trim() || isFiltered(filter()) ? t("inspector.hist.noMatchDesc") : t("inspector.hist.noneDesc")}
                  action={isFiltered(filter()) ? <Button onClick={() => setFilter(NO_FILTER)}>{t("inspector.hist.clear")}</Button> : undefined}
                />
              }
            >
              <ul class="hist__rows" aria-label={t("inspector.hist.count", { n: shown().length })}>
                <For each={shown()}>
                  {(r) => (
                    <li class="hist-row" data-expired={r.transcriptExpired ? "" : undefined}>
                      <StatusDot tone={STATUS[r.status].tone} label={STATUS[r.status].text()} />
                      <button type="button" class="hist-row__main" onClick={() => openInspector({ runId: r.id, title: r.title, role: r.roleId, repoIds: r.repoIds })}>
                        <span class="hist-row__title ui-truncate">{r.title}</span>
                        <span class="hist-row__meta">
                          <Badge size="sm">{r.roleId}</Badge>
                          <Show when={r.model}>
                            <span class="ui-text-3">{modelLabel(r.model!)}</span>
                          </Show>
                          <Show when={r.forkedFrom}>
                            <Badge size="sm" tone="info">{t("inspector.hist.fork")}</Badge>
                          </Show>
                          <Show when={r.transcriptExpired}>
                            <Badge size="sm" tone="warn" title={t("inspector.hist.expiredTip")}>{t("inspector.expired")}</Badge>
                          </Show>
                        </span>
                      </button>
                      <span class="hist-row__repos">
                        <For each={r.repoIds ?? []}>{(id) => <Show when={repoConfig(id)} fallback={<Badge size="sm">{id}</Badge>}>{(c) => <RepoBadge color={c().color} badge={c().badge} size={20} title={c().name} />}</Show>}</For>
                      </span>
                      <span class="hist-row__when ui-tnum" title={new Date(r.startedMs).toLocaleString()}>
                        {relativeTime(r.startedMs, Date.now())}
                      </span>
                      <span class="hist-row__cost ui-tnum" title={t("inspector.hist.estimate")}>{r.costUsd === undefined ? "" : r.costUsd < 0.01 ? "<$0.01" : `$${r.costUsd.toFixed(2)}`}</span>
                      <span class="hist-row__actions">
                        <For each={["resume", "fork"] as const}>
                          {(kind) => (
                            <Tooltip label={continueGate(r).reason ?? (kind === "resume" ? t("inspector.hist.resumeTip") : t("inspector.hist.forkTip"))}>
                              <span>
                                <Button size="sm" variant="ghost" disabled={!continueGate(r).ok} loading={busy() === `${kind}:${r.id}`} onClick={() => void act(kind, r)}>
                                  {kind === "resume" ? t("inspector.resume") : t("inspector.fork")}
                                </Button>
                              </span>
                            </Tooltip>
                          )}
                        </For>
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
        </Show>
      </div>
    </section>
  );
}
