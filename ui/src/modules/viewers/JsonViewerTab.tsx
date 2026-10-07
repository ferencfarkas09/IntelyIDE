import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { execute } from "../../platform/commands";
import type { TabInstance } from "../../platform/tabs";
import { Badge, Braces, Button, ChevronRight, ChevronsDownUp, ChevronsUpDown, Copy, EmptyState, Hash, IconButton, Input, ProgressBar, Search, ArrowDown, ArrowUp, toast, TriangleAlert } from "../../ui-kit";
import { createDocClient, type DocClient, type DocState } from "./client";
import type { Level, Row, SearchHit } from "./engine";
import type { Key } from "./jsonPath";
import { loadInto, TooLargeError } from "./loader";
import { dataKindOf, formatBytes, MAX_DATA_BYTES } from "./logic";
import "./viewers.css";

const ROW_H = 24;
const OVERSCAN = 30;

interface Params {
  repoId: string;
  path: string;
}

/** Tab type `jsonview`: a virtualised tree for .json, .jsonl/.ndjson and .log files up to 50 MB, parsed in a worker. */
export default function JsonViewerTab(props: { tab: TabInstance }) {
  const params = () => props.tab.params as unknown as Params;
  const kind = () => dataKindOf(params().path) ?? "log";
  const client: DocClient = createDocClient();
  onCleanup(() => client.dispose());

  const [state, setState] = createSignal<DocState>();
  const [progress, setProgress] = createSignal(0);
  const [size, setSize] = createSignal(0);
  const [truncated, setTruncated] = createSignal(false);
  const [failure, setFailure] = createSignal<{ tooLarge?: number; message?: string }>();
  const [total, setTotal] = createSignal(0);
  const [rows, setRows] = createSignal<Row[]>([]);
  const [first, setFirst] = createSignal(0);
  const [selected, setSelected] = createSignal<Row>();
  const [query, setQuery] = createSignal("");
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  const [hitInfo, setHitInfo] = createSignal<{ truncated: boolean; error?: string }>({ truncated: false });
  const [hitIndex, setHitIndex] = createSignal(-1);
  const [counts, setCounts] = createSignal<Record<Level, number>>({ error: 0, warn: 0, info: 0, debug: 0 });
  let viewport!: HTMLDivElement;
  let cancelled = false;
  onCleanup(() => (cancelled = true));

  let fetchSeq = 0;
  async function fetchWindow(): Promise<void> {
    const seq = ++fetchSeq;
    const top = Math.max(0, Math.floor(viewport.scrollTop / ROW_H) - OVERSCAN);
    const count = Math.ceil(viewport.clientHeight / ROW_H) + OVERSCAN * 2;
    const win = await client.window(top, count);
    if (seq !== fetchSeq) return;
    setFirst(top);
    setRows(win);
  }

  async function reload(newTotal?: number): Promise<void> {
    const s = await client.state();
    setState(s);
    setTotal(newTotal ?? s.total);
    await fetchWindow();
  }

  onMount(async () => {
    try {
      const res = await loadInto(client, params().repoId, params().path, kind(), {
        isCancelled: () => cancelled,
        onProgress: (f, s) => {
          setProgress(f);
          setState(s);
          setTotal(s.total);
          if (f === 1 || s.lineCount % 5 === 0) void fetchWindow();
        },
      });
      setSize(res.size);
      setTruncated(res.truncated);
      setState(res.state);
      if (kind() !== "json") setCounts(await client.levelCounts());
      await reload();
    } catch (e) {
      if (e instanceof TooLargeError) setFailure({ tooLarge: e.size });
      else setFailure({ message: (e as { message?: string }).message ?? String(e) });
    }
  });

  const busy = () => state()?.loading ?? !failure();

  async function toggle(index: number): Promise<void> {
    const tg = await client.toggle(index);
    await reload(tg);
  }

  async function revealPath(path: Key[]): Promise<void> {
    const idx = await client.reveal(path);
    await reload();
    if (idx >= 0) {
      const [row] = await client.window(idx, 1);
      viewport.scrollTop = Math.max(0, idx * ROW_H - viewport.clientHeight / 3);
      setSelected(row);
      await fetchWindow();
    }
  }

  async function runSearch(q: string): Promise<void> {
    setQuery(q);
    if (!q.trim()) {
      setHits([]);
      setHitInfo({ truncated: false });
      setHitIndex(-1);
      return;
    }
    const r = await client.search(q);
    if (q !== query()) return;
    setHits(r.hits);
    setHitInfo({ truncated: r.truncated, error: r.error });
    setHitIndex(-1);
    if (r.hits.length) await stepHit(1);
  }

  async function stepHit(dir: 1 | -1): Promise<void> {
    const n = hits().length;
    if (!n) return;
    const next = (hitIndex() + dir + n) % n;
    setHitIndex(next);
    await revealPath(hits()[next].path);
  }

  async function copy(what: "path" | "value", row = selected()): Promise<void> {
    if (!row) return;
    const text = what === "path" ? await client.pathText(row.path) : await client.valueText(row.path);
    try {
      await navigator.clipboard.writeText(text);
      toast.success(what === "path" ? t("viewers.json.pathCopied") : t("viewers.json.valueCopied"));
    } catch {
      toast.error(t("viewers.json.copyFailed"));
    }
  }

  async function jumpLevel(level: Level, dir: 1 | -1): Promise<void> {
    const from = selected()?.path[0] ?? (dir === 1 ? -1 : total());
    const i = await client.nextLevel(level, typeof from === "number" ? from : -1, dir);
    if (i >= 0) await revealPath([i]);
    else toast.info(level === "error" ? t("viewers.json.noMoreError") : t("viewers.json.noMoreWarn"));
  }

  function onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    const cur = selected();
    const list = rows();
    const at = cur ? list.findIndex((r) => r.id === cur.id) : -1;
    const select = (i: number) => {
      const r = list[Math.max(0, Math.min(list.length - 1, i))];
      if (r) {
        setSelected(r);
        const abs = first() + list.indexOf(r);
        if (abs * ROW_H < viewport.scrollTop) viewport.scrollTop = abs * ROW_H;
        else if ((abs + 1) * ROW_H > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = (abs + 1) * ROW_H - viewport.clientHeight;
      }
    };
    if (e.key === "ArrowDown") (e.preventDefault(), select(at + 1));
    else if (e.key === "ArrowUp") (e.preventDefault(), select(at < 0 ? 0 : at - 1));
    else if ((e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "Enter") && cur && at >= 0 && (cur.expandable || cur.more !== undefined)) {
      if (e.key === "Enter" || (e.key === "ArrowRight") !== cur.open) (e.preventDefault(), void toggle(first() + at));
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c" && cur && !window.getSelection()?.toString()) (e.preventDefault(), void copy("value"));
  }

  createEffect(on(total, () => viewport && void fetchWindow(), { defer: true }));

  const isLines = () => kind() !== "json" || !!state()?.fellBackToText;
  const subtitle = createMemo(() => {
    const s = state();
    if (!s) return "";
    return isLines() ? t("viewers.json.sizeLines", { size: formatBytes(size()), n: s.lineCount }) : t("viewers.json.sizeRows", { size: formatBytes(size()), n: total() });
  });

  return (
    <div class="vw" data-kind={kind()}>
      <div class="vw__bar">
        <Braces size={14} aria-hidden="true" />
        <span class="vw__name ui-truncate" title={params().path}>
          {params().path}
        </span>
        <Show when={subtitle()}>
          <span class="vw__meta ui-tnum">{subtitle()}</span>
        </Show>
        <Show when={truncated()}>
          <Badge tone="warn" title={t("viewers.json.onlyFirst", { size: formatBytes(MAX_DATA_BYTES) })}>{t("viewers.json.first", { size: formatBytes(MAX_DATA_BYTES) })}</Badge>
        </Show>
        <span class="vw__spacer" />
        <Show when={isLines() && (counts().error > 0 || counts().warn > 0)}>
          <div class="vw__levels" role="group" aria-label={t("viewers.json.levels")}>
            <Show when={counts().error > 0}>
              <button type="button" class="vw__level" data-level="error" onClick={() => void jumpLevel("error", 1)} title={t("viewers.json.nextError")} onContextMenu={(e) => (e.preventDefault(), void jumpLevel("error", -1))}>
                {t("viewers.json.errors", { n: counts().error })}
              </button>
            </Show>
            <Show when={counts().warn > 0}>
              <button type="button" class="vw__level" data-level="warn" onClick={() => void jumpLevel("warn", 1)} title={t("viewers.json.nextWarn")}>
                {t("viewers.json.warnings", { n: counts().warn })}
              </button>
            </Show>
          </div>
        </Show>
        <IconButton icon={ChevronsUpDown} label={t("viewers.json.expand")} size="sm" onClick={() => void client.expandLevel(2).then(reload)} />
        <IconButton icon={ChevronsDownUp} label={t("viewers.json.collapse")} size="sm" onClick={() => void client.collapseAll().then(reload)} />
        <IconButton icon={Hash} label={t("viewers.json.copyPath")} size="sm" disabled={!selected()} onClick={() => void copy("path")} />
        <IconButton icon={Copy} label={t("viewers.json.copyValue")} shortcut={["⌘", "C"]} size="sm" disabled={!selected()} onClick={() => void copy("value")} />
      </div>

      <div class="vw__search">
        <Input
          size="sm"
          leading={<Search size={13} />}
          placeholder={isLines() ? t("viewers.json.searchLines") : t("viewers.json.searchKeys")}
          aria-label={t("viewers.json.search")}
          value={query()}
          onInput={(e) => void runSearch(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.preventDefault(), void stepHit(e.shiftKey ? -1 : 1));
          }}
          invalid={!!hitInfo().error}
          trailing={
            <Show when={query().trim()}>
              <span class="vw__count ui-tnum">{hitInfo().error ? t("viewers.json.queryError") : `${hitIndex() >= 0 ? hitIndex() + 1 : 0} / ${hits().length.toLocaleString()}${hitInfo().truncated ? "+" : ""}`}</span>
            </Show>
          }
        />
        <IconButton icon={ArrowUp} label={t("viewers.json.prev")} size="sm" disabled={!hits().length} onClick={() => void stepHit(-1)} />
        <IconButton icon={ArrowDown} label={t("viewers.json.next")} size="sm" disabled={!hits().length} onClick={() => void stepHit(1)} />
      </div>
      <Show when={hitInfo().error}>
        <div class="vw__note" data-tone="danger" role="alert">
          <TriangleAlert size={13} aria-hidden="true" /> {hitInfo().error}
        </div>
      </Show>
      <Show when={state()?.fellBackToText}>
        <div class="vw__note" data-tone="warn" role="status">
          <TriangleAlert size={13} aria-hidden="true" /> {t("viewers.json.notJson", { error: state()?.error ?? "" })}
        </div>
      </Show>
      <Show when={(state()?.badLines ?? 0) > 0}>
        <div class="vw__note" data-tone="warn" role="status">
          <TriangleAlert size={13} aria-hidden="true" /> {t("viewers.json.badLines", { n: state()!.badLines })}
        </div>
      </Show>
      <Show when={busy()}>
        <ProgressBar value={Math.round(progress() * 100)} aria-label={t("viewers.json.loading")} />
      </Show>

      <Show
        when={!failure()}
        fallback={
          <Show
            when={failure()!.tooLarge}
            fallback={<EmptyState icon={TriangleAlert} tone="danger" title={t("viewers.json.openFailed")} description={failure()!.message} />}
          >
            <EmptyState
              icon={Braces}
              title={t("viewers.json.tooLarge")}
              description={t("viewers.json.tooLargeDesc", { size: formatBytes(failure()!.tooLarge!), max: formatBytes(MAX_DATA_BYTES) })}
              action={
                <Button size="sm" onClick={() => void execute("editor.openFile", { repoId: params().repoId, path: params().path })}>
                  {t("viewers.json.openEditor")}
                </Button>
              }
            />
          </Show>
        }
      >
        <div class="vw__body">
          <div class="vw__tree ui-selectable" ref={viewport} tabIndex={0} role="tree" aria-label={t("viewers.json.contents", { path: params().path })} aria-rowcount={total()} onScroll={() => void fetchWindow()} onKeyDown={onKey}>
            <div class="vw__sizer" style={{ height: `${total() * ROW_H}px` }}>
              <For each={rows()}>
                {(row, i) => (
                  <div
                    class="vw__row"
                    role="treeitem"
                    aria-level={row.depth + 1}
                    aria-expanded={row.expandable ? row.open : undefined}
                    aria-selected={selected()?.id === row.id}
                    data-type={row.type}
                    data-level={row.level}
                    data-more={row.more !== undefined ? "" : undefined}
                    data-selected={selected()?.id === row.id ? "" : undefined}
                    style={{ transform: `translateY(${(first() + i()) * ROW_H}px)`, "padding-left": `${8 + row.depth * 14}px` }}
                    onClick={() => {
                      setSelected(row);
                      if (row.more !== undefined || row.expandable) void toggle(first() + i());
                    }}
                    onDblClick={() => row.type === "line" && void copy("value", row)}
                  >
                    <span class="vw__twisty" data-open={row.open ? "" : undefined} data-visible={row.expandable || row.more !== undefined ? "" : undefined}>
                      <ChevronRight size={12} aria-hidden="true" />
                    </span>
                    <Show
                      when={row.type !== "line"}
                      fallback={
                        <>
                          <span class="vw__gutter ui-tnum">{row.label}</span>
                          <span class="vw__text ui-mono">{row.preview}</span>
                        </>
                      }
                    >
                      <Show when={row.depth === 0 && isLines()}>
                        <span class="vw__gutter ui-tnum">{row.label}</span>
                      </Show>
                      <Show when={row.more === undefined && !(row.depth === 0 && isLines())}>
                        <span class="vw__key ui-mono">{row.label}</span>
                        <span class="vw__colon">:</span>
                      </Show>
                      <span class="vw__val ui-mono ui-truncate" data-type={row.type}>
                        {row.preview}
                      </span>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </div>
          <Show when={hits().length > 1}>
            <aside class="vw__hits" aria-label={t("viewers.json.matchesAria")}>
              <div class="vw__hits-head ui-tnum">
                {t("viewers.json.matches", { count: hits().length.toLocaleString() + (hitInfo().truncated ? "+" : "") })}
              </div>
              <ul>
                <For each={hits().slice(0, 300)}>
                  {(h, i) => (
                    <li>
                      <button type="button" class="vw__hit" data-active={hitIndex() === i() ? "" : undefined} onClick={() => (setHitIndex(i()), void revealPath(h.path))}>
                        <span class="vw__hit-path ui-mono ui-truncate">{h.pathText}</span>
                        <span class="vw__hit-val ui-mono ui-truncate" data-type={h.type}>
                          {h.preview}
                        </span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </aside>
          </Show>
        </div>
      </Show>
    </div>
  );
}
