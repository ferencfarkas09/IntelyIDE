import { createEffect, createMemo, createSignal, createUniqueId, For, on, Show } from "solid-js";
import { repos } from "../../store/workspace";
import { Badge, ChevronRight, EmptyState, FileText, Icon, Info, Input, Pill, RepoBadge, Search, Spinner, Tooltip, TriangleAlert } from "../../ui-kit";
import { buildMatcher, flattenRows, groupHits, highlightRanges, moveIndex, previewWindow, segments, splitPath, type Row } from "./logic";
import { openHit } from "./openHit";
import { t } from "../../i18n";
import { AUTO_MIN_LENGTH, cancelSearch, caseSensitive, error, excluded, focusTick, glob, hits, MAX_HITS, query, regex, notice, runSearch, setGlob, setQuery, status, toggleCase, toggleRegex, toggleRepo, truncated } from "./state";
import "./search.css";

function Highlighted(props: { text: string; matcher: RegExp | null }) {
  const view = createMemo(() => {
    const cut = previewWindow(props.text, highlightRanges(props.text, props.matcher));
    return segments(cut.text, cut.ranges);
  });
  return <For each={view()}>{(s) => (s.match ? <mark class="sp__mark">{s.text}</mark> : <>{s.text}</>)}</For>;
}

function summary(count: number, files: number, running: boolean): string {
  return t(running ? "search.summarySoFar" : "search.summary", { count, files });
}

export default function SearchPanel() {
  const uid = createUniqueId();
  let input!: HTMLInputElement;
  let list!: HTMLDivElement;
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const [activeKey, setActiveKey] = createSignal<string | null>(null);

  const groups = createMemo(() => groupHits(hits()));
  const rows = createMemo(() => flattenRows(groups(), collapsed()));
  const activeIndex = () => rows().findIndex((r) => r.key === activeKey());
  const matcher = createMemo(() => buildMatcher({ query: query(), regex: regex(), caseSensitive: caseSensitive() }));
  const multiRepo = () => repos().length > 1;
  const repoOf = (id: string) => repos().find((r) => r.id === id);
  const rowId = (key: string) => `${uid}-${rows().findIndex((r) => r.key === key)}`;

  createEffect(on(focusTick, () => queueMicrotask(() => (input.focus(), input.select()))));
  // A new result set starts without a stale active row.
  createEffect(on(query, () => setActiveKey(null), { defer: true }));
  createEffect(() => {
    const key = activeKey();
    if (key) list.querySelector(`[data-key="${CSS.escape(key)}"]`)?.scrollIntoView?.({ block: "nearest" });
  });

  const toggleGroup = (key: string) =>
    setCollapsed((all) => {
      const next = new Set(all);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const activate = (row: Row) => {
    setActiveKey(row.key);
    if (row.kind === "file") toggleGroup(row.key);
    else openHit(row.hit.repoId, row.hit.path, row.hit.line, row.hit.col);
  };
  const focusList = () => {
    const first = rows().find((r) => r.kind === "hit") ?? rows()[0];
    if (!first) return;
    setActiveKey(first.key);
    list.focus();
  };

  const onListKey = (e: KeyboardEvent) => {
    const all = rows();
    const at = activeIndex();
    const row = all[at];
    const go = (i: number) => (e.preventDefault(), setActiveKey(all[i]?.key ?? null));
    if (e.key === "ArrowDown") go(at < 0 ? 0 : moveIndex(at, 1, all.length));
    else if (e.key === "ArrowUp") (at <= 0 ? (e.preventDefault(), input.focus()) : go(moveIndex(at, -1, all.length)));
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(all.length - 1);
    else if (e.key === "ArrowLeft" && row) {
      e.preventDefault();
      if (row.kind === "hit") setActiveKey(row.group.key);
      else if (!collapsed().has(row.key)) toggleGroup(row.key);
    } else if (e.key === "ArrowRight" && row?.kind === "file" && collapsed().has(row.key)) {
      e.preventDefault();
      toggleGroup(row.key);
    } else if ((e.key === "Enter" || e.key === " ") && row) {
      e.preventDefault();
      activate(row);
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.focus();
    }
  };

  const onInputKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void runSearch();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusList();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (status() === "running") cancelSearch();
      else if (query()) setQuery("");
    }
  };

  const toggle = (label: string, text: string, pressed: () => boolean, on: () => void) => (
    <Tooltip label={label}>
      <button type="button" class="sp__tog" aria-label={label} aria-pressed={pressed()} onClick={on}>
        {text}
      </button>
    </Tooltip>
  );

  const idle = () => status() === "idle" && !query();
  return (
    <section class="sp" aria-label={t("search.title")}>
      <header class="sp__head">
        <Input
          ref={input}
          size="sm"
          placeholder={t("search.findInFiles")}
          aria-label={t("search.query")}
          autocomplete="off"
          spellcheck={false}
          invalid={status() === "error" && !!error()}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onInputKey}
          leading={<Icon icon={Search} size={14} />}
          trailing={
            <span class="sp__togs">
              {toggle(t("search.matchCase"), "Aa", caseSensitive, toggleCase)}
              {toggle(t("search.regex"), ".*", regex, toggleRegex)}
            </span>
          }
        />
        <Input size="sm" placeholder={t("search.globPh")} aria-label={t("search.fileFilter")} autocomplete="off" spellcheck={false} value={glob()} onInput={(e) => setGlob(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && void runSearch()} leading={<Icon icon={FileText} size={14} />} />
        <Show when={multiRepo()}>
          <div class="sp__chips" role="group" aria-label={t("search.repos")}>
            <For each={repos()}>
              {(repo) => (
                <Pill size="sm" selected={!excluded().has(repo.id)} onClick={() => toggleRepo(repo.id)} aria-label={t("search.inRepo", { name: repo.name })} buttonProps={{ "aria-pressed": !excluded().has(repo.id) }} leading={<RepoBadge color={repo.color} badge={repo.badge} size={16} />}>
                  {repo.name}
                </Pill>
              )}
            </For>
          </div>
        </Show>
      </header>

      <div class="sp__status" role="status" aria-live="polite">
        <Show when={status() === "running"}>
          <Spinner size={12} />
        </Show>
        <Show when={status() === "error" && error()}>
          <span class="sp__error">
            <Icon icon={TriangleAlert} size={12} /> {error()}
          </span>
        </Show>
        <Show when={status() !== "error" && (hits().length > 0 || status() === "running")}>
          <span>{summary(hits().length, groups().length, status() === "running")}</span>
        </Show>
        <Show when={truncated()}>
          <span class="sp__limit">{t("search.limit", { n: MAX_HITS })}</span>
        </Show>
      </div>

      <Show when={notice()}>
        {(text) => (
          <div class="sp__hint" role="note">
            <Icon icon={Info} size={12} /> <span class="ui-truncate" title={text()}>{text()}</span>
          </div>
        )}
      </Show>

      <div ref={list} class="sp__results" role="tree" aria-label={t("search.results")} tabIndex={rows().length ? 0 : -1} aria-activedescendant={activeKey() ? rowId(activeKey()!) : undefined} onKeyDown={onListKey}>
        <For each={rows()}>
          {(row) =>
            row.kind === "file" ? (
              <div id={rowId(row.key)} class="sp__file" role="treeitem" aria-level={1} aria-expanded={!collapsed().has(row.key)} aria-selected={activeKey() === row.key} data-key={row.key} onClick={() => activate(row)}>
                <Icon icon={ChevronRight} size={12} class="sp__chev" />
                <Show when={multiRepo() && repoOf(row.group.repoId)}>{(r) => <RepoBadge color={r().color} badge={r().badge} size={16} />}</Show>
                <span class="sp__name">{splitPath(row.group.path).name}</span>
                <span class="sp__dir ui-truncate">{splitPath(row.group.path).dir}</span>
                <Badge size="sm" numeric>
                  {row.group.hits.length}
                </Badge>
              </div>
            ) : (
              <div id={rowId(row.key)} class="sp__hit" role="treeitem" aria-level={2} aria-selected={activeKey() === row.key} data-key={row.key} onClick={() => activate(row)}>
                <span class="sp__line ui-tnum">{row.hit.line}</span>
                <span class="sp__text ui-mono">
                  <Highlighted text={row.hit.preview} matcher={matcher()} />
                </span>
              </div>
            )
          }
        </For>
        <Show when={status() === "done" && hits().length === 0}>
          <EmptyState size="sm" icon={Search} title={t("search.none")} description={t("search.noneDesc", { query: query() })} />
        </Show>
        <Show when={idle()}>
          <EmptyState size="sm" icon={Search} title={t("search.all")} description={t("search.typeMin", { n: AUTO_MIN_LENGTH })} />
        </Show>
      </div>
    </section>
  );
}
