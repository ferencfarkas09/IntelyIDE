import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { GraphRow } from "../../ipc/graph";
import { snapshots } from "../../store/snapshots";
import { repoConfig, repos } from "../../store/workspace";
import { EmptyState, GitBranch, Icon, IconButton, Input, RefreshCw, Rewind, Search, Select, Skeleton, TriangleAlert } from "../../ui-kit";
import { CommitDetailPane } from "./CommitDetailPane";
import "./graph.css";
import { firstLine, listDate, shortOid } from "./format";
import { LaneCanvas, LANE_W, ROW_H } from "./LaneCanvas";
import { OpBanner } from "./OpBanner";
import { Refs } from "./Refs";
import { layoutRows } from "./lanes";
import { author, branch, clearRepoFilter, error, loading, loadMore, period, reloadLog, repoFilter, rows, selection, setAuthor, setBranch, setPeriod, setSelection, setText, shownRepoIds, text, toggleRepoFilter, type Period } from "./logState";
import { openMatrix } from "./openers";
import { RebaseDialog } from "./RebaseDialog";
import { openRebase } from "./rebaseState";

const OVERSCAN = 8;
const MAX_LANES = 10;

const periods = (): { value: Period; label: string }[] => [
  { value: "any", label: t("graph.log.anyDate") },
  { value: "day", label: t("graph.log.day") },
  { value: "week", label: t("graph.log.week") },
  { value: "month", label: t("graph.log.month") },
];

function Toolbar() {
  const [typed, setTyped] = createSignal("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const search = (value: string) => {
    setTyped(value);
    clearTimeout(timer);
    timer = setTimeout(() => setText(value), 250);
  };
  onCleanup(() => clearTimeout(timer));
  const [branches] = createResource(shownRepoIds, async (ids) => (await ipc.graph.branchMatrix(ids)).branches.map((b) => b.name));
  return (
    <div class="glog__bar" role="toolbar" aria-label={t("graph.log.filters")}>
      <div class="glog__chips" role="group" aria-label={t("graph.log.repos")}>
        <button type="button" class="glog__chip" aria-pressed={repoFilter().length === 0} onClick={clearRepoFilter}>
          {t("graph.log.all")}
        </button>
        <For each={repos()}>
          {(repo) => (
            <button type="button" class="glog__chip" aria-pressed={repoFilter().includes(repo.id)} onClick={() => toggleRepoFilter(repo.id)} style={{ "--chip-color": repo.color }}>
              <span class="glog__chip-dot" />
              {repo.name}
            </button>
          )}
        </For>
      </div>
      <Select size="sm" wrapperClass="glog__select" aria-label={t("graph.log.branch")} value={branch()} onChange={setBranch} options={[{ value: "", label: t("graph.log.allBranches") }, ...(branches() ?? []).map((name) => ({ value: name, label: name }))]} />
      <Input size="sm" wrapperClass="glog__author" aria-label={t("graph.log.author")} placeholder={t("graph.log.author")} value={author()} onInput={(e) => setAuthor(e.currentTarget.value)} />
      <Select size="sm" wrapperClass="glog__select" aria-label={t("graph.log.date")} value={period()} onChange={setPeriod} options={periods()} />
      <Input size="sm" wrapperClass="glog__search" aria-label={t("graph.log.search")} data-log-search placeholder={t("graph.log.searchPlaceholder")} leading={<Icon icon={Search} size={12} />} value={typed()} onInput={(e) => search(e.currentTarget.value)} />
      <span class="glog__tools">
        <IconButton icon={RefreshCw} size="sm" label={t("graph.log.refresh")} loading={loading()} onClick={() => void reloadLog()} />
        <IconButton icon={GitBranch} size="sm" label={t("graph.matrix.title")} onClick={openMatrix} />
        <IconButton icon={Rewind} size="sm" label={t("graph.cmd.rebase")} onClick={() => openRebase()} />
      </span>
    </div>
  );
}

/** The Log tool window: filters on top, the commit list with its lane graph, the detail of the selected commit on the right. */
export default function LogPanel() {
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewH, setViewH] = createSignal(400);
  let scroller!: HTMLDivElement;

  const layout = createMemo(() => layoutRows(rows()));
  const graphWidth = () => Math.min(layout().width, MAX_LANES) * LANE_W + 8;
  const first = () => Math.max(0, Math.floor(scrollTop() / ROW_H) - OVERSCAN);
  const last = () => Math.min(rows().length, Math.ceil((scrollTop() + viewH()) / ROW_H) + OVERSCAN);
  const visible = createMemo(() => rows().slice(first(), last()).map((row, i) => ({ row, index: first() + i })));
  const selectedIndex = () => rows().findIndex((r) => r.oid === selection()?.oid && r.repoId === selection()?.repoId);

  // The list reloads when the repos, filters or any repo's HEAD change.
  const heads = () => repos().map((r) => snapshots()[r.id]?.head.oid ?? "").join(",");
  const query = () => `${shownRepoIds().join(",")}|${branch()}|${author()}|${period()}|${text()}`;
  createEffect(
    on(query, () => {
      if (scroller) scroller.scrollTop = 0;
    }, { defer: true }),
  );
  createEffect(on(() => [query(), heads()], () => void reloadLog()));
  createEffect(on(() => rows().length - last(), (left) => left < 15 && void loadMore()));

  const observe = (el: HTMLDivElement) => {
    scroller = el;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight || 400));
    ro.observe(el);
    onCleanup(() => ro.disconnect());
  };

  const select = (row: GraphRow, index?: number) => {
    setSelection({ repoId: row.repoId, oid: row.oid });
    if (index === undefined) return;
    const top = index * ROW_H;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (top + ROW_H > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + ROW_H - scroller.clientHeight;
  };

  const onKey = (e: KeyboardEvent) => {
    const list = rows();
    if (!list.length) return;
    const at = selectedIndex();
    const page = Math.max(1, Math.floor(viewH() / ROW_H) - 1);
    const target = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "PageDown" ? at + page : e.key === "PageUp" ? at - page : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : null;
    if (target === null) return;
    e.preventDefault();
    const index = Math.min(Math.max(target, 0), list.length - 1);
    select(list[index], index);
  };

  return (
    <section class="glog" aria-label={t("graph.log.title")}>
      <Toolbar />
      <OpBanner />
      <div class="glog__main">
        <div class="glog__list" tabIndex={0} role="listbox" aria-label={t("graph.log.commits")} aria-activedescendant={selectedIndex() >= 0 ? `glog-row-${selectedIndex()}` : undefined} onKeyDown={onKey}>
          <div class="glog__scroll" ref={observe} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
            <Show when={rows().length > 0} fallback={<LogEmpty />}>
              <div class="glog__content" style={{ height: `${rows().length * ROW_H}px` }}>
                <LaneCanvas rows={layout().rows} first={first()} last={last()} width={graphWidth()} />
                <For each={visible()}>
                  {(item) => (
                    <div
                      id={`glog-row-${item.index}`}
                      class="glog__row"
                      role="option"
                      aria-selected={selectedIndex() === item.index}
                      style={{ transform: `translateY(${item.index * ROW_H}px)`, "--repo": repoConfig(item.row.repoId)?.color ?? "var(--text-4)" }}
                      onClick={() => select(item.row)}
                    >
                      <span class="glog__stripe" title={repoConfig(item.row.repoId)?.name} />
                      <span class="glog__gutter" style={{ width: `${graphWidth()}px` }} />
                      <Refs decorations={item.row.decorations} />
                      <span class="glog__subject ui-truncate" title={item.row.subject}>
                        {firstLine(item.row.subject)}
                      </span>
                      <span class="glog__author-col ui-truncate">{item.row.author}</span>
                      <span class="glog__date ui-tnum">{listDate(item.row.dateMs)}</span>
                      <span class="glog__oid ui-mono">{shortOid(item.row.oid)}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>
        <Show when={selection()}>{(sel) => <CommitDetailPane selection={sel()} />}</Show>
      </div>
      <RebaseDialog />
    </section>
  );
}

function LogEmpty() {
  return (
    <Show
      when={!loading()}
      fallback={
        <div class="glog__loading" aria-busy="true" aria-label={t("graph.log.loading")}>
          <For each={[70, 55, 80, 48, 64, 58]}>{(w) => <Skeleton height={14} width={`${w}%`} />}</For>
        </div>
      }
    >
      <Show when={error()} fallback={<EmptyState size="sm" icon={Search} title={t("graph.log.noMatch")} description={t("graph.log.noMatchDesc")} />}>
        {(message) => <EmptyState size="sm" tone="danger" icon={TriangleAlert} title={t("graph.log.failed")} description={message()} />}
      </Show>
    </Show>
  );
}
