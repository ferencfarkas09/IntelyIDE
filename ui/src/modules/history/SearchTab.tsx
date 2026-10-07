import { createMemo, For, onMount, Show } from "solid-js";
import { t, fmt } from "../../i18n";
import { repoName } from "../../store/actions";
import { foreignReason, hiddenCount, isForeign, scopeRows, setShowOtherWorkspaces, showOtherWorkspaces } from "../../store/agentScope";
import { Badge, Button, Checkbox, EmptyState, FileSearch, Gauge, History, Icon, Input, ListChecks, RefreshCw, Search, SegmentedControl, Select, Skeleton, TriangleAlert } from "../../ui-kit";
import { openHistory, openInspector, openReview } from "../inspector/openers";
import { usd } from "./format";
import { openCockpit } from "./open";
import { busy, error, facets, filters, hits, indexed, runSearch, searched, searchSoon, setFilters, setText, text, tookMs, total, type Filters, type When } from "./search";
import type { SearchHit, Snippet } from "./types";
import "./history.css";

const STATUS_TONE = { running: "info", done: "ok", failed: "danger", cancelled: "neutral" } as const;
const STATUS_KEY = { running: "history.status.running", done: "history.status.done", failed: "history.status.failed", cancelled: "history.status.cancelled" } as const;
const FIELD_KEY = { title: "history.field.title", prompt: "history.field.prompt", reply: "history.field.reply", tool: "history.field.tool", file: "history.field.file" } as const;

/** The snippet text with its marked ranges wrapped in <mark>. */
export function Highlighted(props: { snippet: Snippet }) {
  const parts = createMemo(() => {
    const chars = [...props.snippet.text];
    const out: { text: string; mark: boolean }[] = [];
    let at = 0;
    for (const [a, b] of props.snippet.marks) {
      if (a > at) out.push({ text: chars.slice(at, a).join(""), mark: false });
      out.push({ text: chars.slice(a, b).join(""), mark: true });
      at = b;
    }
    if (at < chars.length) out.push({ text: chars.slice(at).join(""), mark: false });
    return out;
  });
  return <For each={parts()}>{(p) => (p.mark ? <mark class="hs__mark">{p.text}</mark> : <>{p.text}</>)}</For>;
}

const runParams = (h: SearchHit) => ({ runId: h.runId, title: h.title, role: h.role, repoIds: h.repoIds });

function Result(props: { hit: SearchHit }) {
  const h = () => props.hit;
  const when = () => (h().startedMs ? fmt.date(h().startedMs, "medium") : "");
  const foreign = () => isForeign(h().repoIds);
  return (
    <li class="hs__hit" data-run={h().runId} data-foreign={foreign() ? "" : undefined}>
      <div class="hs__top">
        <span class="hs__title ui-truncate" title={h().title}>{h().title}</span>
        <Badge size="sm" tone={STATUS_TONE[h().status as keyof typeof STATUS_TONE] ?? "neutral"}>{STATUS_KEY[h().status as keyof typeof STATUS_KEY] ? t(STATUS_KEY[h().status as keyof typeof STATUS_KEY]) : h().status}</Badge>
      </div>
      <div class="hs__meta">
        <Show when={h().role}><span>{h().role}</span></Show>
        <Show when={h().model}><span class="ui-mono">{h().model}</span></Show>
        <For each={h().repoIds}>{(r) => <Badge size="sm" tone="neutral">{repoName(r)}</Badge>}</For>
        <Show when={when()}><span>{when()}</span></Show>
        <Show when={h().costUsd !== undefined}><span class="ui-tnum">{t("history.cost", { cost: usd(h().costUsd) })}</span></Show>
      </div>
      <Show when={foreign()}>
        <p class="hs__scope" role="note">{foreignReason(h().repoIds)}</p>
      </Show>
      <Show when={h().snippets.length}>
        <ul class="hs__snips">
          <For each={h().snippets}>
            {(s) => (
              <li class="hs__snip">
                <span class="hs__field">{t(FIELD_KEY[s.field] ?? "history.field.reply")}</span>
                <Show when={s.field === "file"} fallback={<span class="hs__text"><Highlighted snippet={s} /></span>}>
                  <span class="hs__text ui-mono"><Highlighted snippet={s} /></span>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div class="hs__acts">
        <Button size="sm" variant="secondary" icon={FileSearch} onClick={() => openInspector(runParams(h()))}>{t("history.act.inspect")}</Button>
        <Button size="sm" variant="ghost" icon={ListChecks} onClick={() => openReview(runParams(h()))}>{t("history.act.review")}</Button>
        <Button size="sm" variant="ghost" icon={Gauge} onClick={() => openCockpit(runParams(h()))}>{t("history.act.context")}</Button>
        <Button size="sm" variant="ghost" icon={History} onClick={() => void openHistory()}>{t("history.act.history")}</Button>
      </div>
    </li>
  );
}

export default function SearchTab() {
  onMount(() => void runSearch());
  const set = (patch: Partial<Filters>) => {
    setFilters({ ...filters(), ...patch });
    void runSearch();
  };
  const opts = (items: { value: string; count: number }[], all: string, label: (v: string) => string = (v) => v) => [{ value: "", label: all }, ...items.map((i) => ({ value: i.value, label: `${label(i.value)} (${i.count})` }))];
  const statusLabel = (v: string) => (STATUS_KEY[v as keyof typeof STATUS_KEY] ? t(STATUS_KEY[v as keyof typeof STATUS_KEY]) : v);
  // Runs of other workspaces stay out of the results until the toggle is on (their transcripts hold file contents).
  const shown = createMemo(() => scopeRows(hits()));
  const hidden = createMemo(() => hiddenCount(hits()));
  const filtered = () => !!(filters().repo || filters().role || filters().model || filters().status || filters().when !== "any" || text().trim());

  return (
    <div class="hs">
      <div class="hs__bar">
        <Input
          class="hs__input"
          data-autofocus
          type="search"
          leading={<Icon icon={Search} size={14} />}
          placeholder={t("history.search.placeholder")}
          aria-label={t("history.search.aria")}
          value={text()}
          onInput={(e) => {
            setText(e.currentTarget.value);
            searchSoon();
          }}
          onKeyDown={(e) => e.key === "Enter" && void runSearch()}
        />
        <Button variant="ghost" size="sm" icon={RefreshCw} loading={busy()} onClick={() => void runSearch(true)}>{t("history.reindex")}</Button>
      </div>
      <div class="hs__filters">
        <Select size="sm" aria-label={t("history.filter.repo")} value={filters().repo} onChange={(v) => set({ repo: v })} options={opts(facets().repos, t("history.filter.repo.all"), repoName)} />
        <Select size="sm" aria-label={t("history.filter.role")} value={filters().role} onChange={(v) => set({ role: v })} options={opts(facets().roles, t("history.filter.role.all"))} />
        <Select size="sm" aria-label={t("history.filter.model")} value={filters().model} onChange={(v) => set({ model: v })} options={opts(facets().models, t("history.filter.model.all"))} />
        <Select size="sm" aria-label={t("history.filter.status")} value={filters().status} onChange={(v) => set({ status: v })} options={opts(facets().statuses, t("history.filter.status.all"), statusLabel)} />
        <SegmentedControl<When>
          size="sm"
          aria-label={t("history.filter.when")}
          value={filters().when}
          onChange={(v) => set({ when: v })}
          options={[
            { value: "any", label: t("history.when.any") },
            { value: "day", label: t("history.when.day") },
            { value: "week", label: t("history.when.week") },
            { value: "month", label: t("history.when.month") },
          ]}
        />
      </div>
      <p class="hs__status" role="status" aria-live="polite">
        <Show when={searched() && !error()}>
          <span class="ui-tnum">{total() > hits().length ? t("history.resultsOf", { shown: hits().length, total: total() }) : t("history.results", { n: total() })}</span>
          <span aria-hidden="true">·</span>
          <span class="ui-tnum">{t("history.indexed", { n: indexed(), ms: tookMs() })}</span>
        </Show>
      </p>
      <Show when={searched() && (hidden() > 0 || showOtherWorkspaces())}>
        <div class="hs__scope-bar">
          <Checkbox size="sm" label={t("scope.toggle")} checked={showOtherWorkspaces()} onChange={setShowOtherWorkspaces} />
          <Show when={hidden() > 0}>
            <span class="hs__hidden" role="status">{t("scope.hidden", { count: hidden() })}</span>
          </Show>
        </div>
      </Show>
      <Show when={error()}>
        <EmptyState size="sm" tone="danger" icon={TriangleAlert} title={t("history.error")} description={error()} />
      </Show>
      <Show when={!searched() && !error()}>
        <Skeleton height={72} />
      </Show>
      <Show when={searched() && !error() && !shown().length && hidden() === 0}>
        <Show when={indexed() > 0 || filtered()} fallback={<EmptyState size="sm" icon={History} title={t("history.none.title")} description={t("history.none.desc")} />}>
          <EmptyState size="sm" icon={Search} title={t("history.empty.title")} description={t("history.empty.desc")} />
        </Show>
      </Show>
      <ul class="hs__list" aria-label={t("history.results.aria")}>
        <For each={shown()}>{(h) => <Result hit={h} />}</For>
      </ul>
      <p class="hs__hint">{t("history.hint")}</p>
    </div>
  );
}
