import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { t } from "../../i18n";
import { ArrowLeft, Badge, Button, Check, Copy, Dialog, EmptyState, ExternalLink, FileText, Input, LiveRegion, Search, SegmentedControl, Select, ShieldCheck, Skeleton } from "../../ui-kit";
import { openLink } from "../AboutCard";
import { ABOUT } from "../aboutText";
import { LicenseDataError, loadIndex, loadTexts } from "./data";
import { linkAction } from "./links";
import { closeLicenses, licensesState } from "./open";
import { filterComponents } from "./search";
import type { Component, KindFilter, LicenseIndex, LicenseTexts } from "./types";
import "./licenses.css";

const PROJECT_ID = "project";
const ROW_HEIGHT = 48;
const NARROW_PX = 720;

export interface LicensesDialogProps {
  /** Tests: jsdom has no layout, so the virtualizer gets a size and a window up front. */
  initialRect?: { width: number; height: number };
  overscan?: number;
  /** Tests: force the single-column layout. */
  narrow?: boolean;
}

type Load<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; kind: "schema" | "load" };
const failure = (e: unknown): { status: "error"; kind: "schema" | "load" } => ({ status: "error", kind: e instanceof LicenseDataError && e.kind === "schema" ? "schema" : "load" });

const projectRow = (p: LicenseIndex["project"]): Component => ({
  id: PROJECT_ID,
  kind: "manual",
  name: p.name,
  version: "",
  expression: p.license,
  chosen: [p.license],
  copyright: [p.copyright],
  textIds: p.textIds,
  shippedIn: [],
  distributed: true,
  verdict: "ok",
});

/** Licenses named in the expression that were not chosen (the muted alternatives of an OR). */
const alternatives = (c: Component): string[] => [...new Set(c.expression.split(/[\s()]+/).filter((x) => x && !/^(AND|OR|WITH)$/i.test(x)))].filter((x) => !c.chosen.includes(x) && x !== c.expression);

const optionId = (id: string) => `lic-opt-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

function ExternalLinkRow(props: { url: string; label: string; extraHosts: string[] }) {
  const link = () => linkAction(props.url, props.extraHosts);
  const [copied, setCopied] = createSignal(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard may be unavailable; the URL text stays visible and selectable.
    }
  };
  return (
    <Show when={link()}>
      {(l) => (
        <div class="lic__link">
          <span class="lic__meta-label">{props.label}</span>
          <Show when={l().action === "copy"}>
            <span class="lic__host" dir="ltr">{l().hostname}</span>
          </Show>
          <Show
            when={l().action === "open"}
            fallback={
              <Button size="sm" variant="ghost" icon={copied() ? Check : Copy} onClick={() => void copy()}>{copied() ? t("licenses.copied") : t("licenses.copy")}</Button>
            }
          >
            <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => openLink(l().url)} aria-label={`${props.label}: ${l().hostname}`}>{l().hostname}</Button>
          </Show>
          <Show when={l().action === "copy"}>
            <code class="lic__url" dir="ltr">{l().url}</code>
          </Show>
        </div>
      )}
    </Show>
  );
}

function Body(props: LicensesDialogProps) {
  const [index, setIndex] = createSignal<Load<LicenseIndex>>({ status: "loading" });
  const [texts, setTexts] = createSignal<Load<LicenseTexts> | { status: "idle" }>({ status: "idle" });
  const [query, setQuery] = createSignal("");
  const [license, setLicense] = createSignal("");
  const [kind, setKind] = createSignal<KindFilter>("all");
  const [selectedId, setSelectedId] = createSignal(PROJECT_ID);
  const [view, setView] = createSignal<"list" | "detail">("list");
  const [measuredNarrow, setMeasuredNarrow] = createSignal(false);
  const [scrollEl, setScrollEl] = createSignal<HTMLDivElement | null>(null);
  const [copiedId, setCopiedId] = createSignal<string | null>(null);
  const [shownCount, setShownCount] = createSignal<number | null>(null);
  let root: HTMLDivElement | undefined;
  let search: HTMLInputElement | undefined;
  let detail: HTMLElement | undefined;
  let listEl: HTMLDivElement | undefined;

  const narrow = () => props.narrow ?? measuredNarrow();

  const loadData = () => {
    setIndex({ status: "loading" });
    loadIndex().then(
      (data) => setIndex({ status: "ready", data }),
      (e) => setIndex(failure(e)),
    );
  };
  const loadText = () => {
    setTexts({ status: "loading" });
    loadTexts().then(
      (data) => setTexts({ status: "ready", data }),
      (e) => setTexts(failure(e)),
    );
  };
  onMount(loadData);

  onMount(() => {
    if (!root || typeof ResizeObserver === "undefined") return;
    const measure = () => setMeasuredNarrow(root!.clientWidth > 0 && root!.clientWidth < NARROW_PX);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    onCleanup(() => ro.disconnect());
  });

  const data = (): LicenseIndex | undefined => {
    const s = index();
    return s.status === "ready" ? s.data : undefined;
  };
  const project = createMemo(() => {
    const d = data();
    return d ? projectRow(d.project) : undefined;
  });
  const rows = createMemo<Component[]>(() => {
    const d = data();
    const p = project();
    if (!d || !p) return [];
    return filterComponents([p, ...d.components], { query: query(), license: license(), kind: kind() });
  });
  const activeIndex = createMemo(() => {
    const i = rows().findIndex((r) => r.id === selectedId());
    return rows().length === 0 ? -1 : i < 0 ? 0 : i;
  });
  const selected = createMemo<Component | undefined>(() => rows()[activeIndex()]);
  const extraHosts = createMemo(() => {
    const u = data()?.project.sourceUrl ?? ABOUT.source;
    try {
      return u ? [new URL(u).hostname] : [];
    } catch {
      return [];
    }
  });

  const virt = createVirtualizer({
    get count() {
      return rows().length;
    },
    getScrollElement: () => scrollEl(),
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (i) => rows()[i]?.id ?? i,
    overscan: props.overscan ?? 8,
    initialRect: props.initialRect,
  });

  // The aria-activedescendant target must stay in the DOM even when it is scrolled out of the virtual window (rows have a fixed height).
  const items = createMemo(() => {
    // A copy: the virtualizer hands out one reactive store, and a memo that returned it again would never notify the list.
    const vi = [...virt.getVirtualItems()];
    const a = activeIndex();
    if (a >= 0 && !vi.some((v) => v.index === a)) vi.push({ index: a, start: a * ROW_HEIGHT, size: ROW_HEIGHT } as (typeof vi)[number]);
    return vi;
  });

  // Opening with a target (About > "View full text") selects it and clears filters so the row is visible.
  createEffect(
    on([() => licensesState(), data], ([st, d]) => {
      if (!st.open || !d) return;
      if (st.select) {
        const id = st.select === "project" ? PROJECT_ID : st.select;
        setQuery("");
        setLicense("");
        setKind("all");
        setSelectedId(id);
        if (narrow()) setView("detail");
        queueMicrotask(() => {
          const i = rows().findIndex((r) => r.id === id);
          if (i >= 0) virt.scrollToIndex(i);
        });
      }
    }),
  );

  // License texts are a second, bigger file: fetched when the first entry that has texts is selected.
  createEffect(() => {
    if ((selected()?.textIds.length ?? 0) > 0 && texts().status === "idle") loadText();
  });

  // The result count is announced politely and debounced; the first value is immediate.
  createEffect(
    on(
      // The pinned project entry is not a component: the count must agree with the filter label ("All licenses (N)").
      () => (data() ? rows().filter((r) => r.id !== PROJECT_ID).length : null),
      (n) => {
        if (n === null) return;
        if (shownCount() === null) return setShownCount(n);
        const timer = setTimeout(() => setShownCount(n), 150);
        onCleanup(() => clearTimeout(timer));
      },
    ),
  );

  const choose = (i: number, scroll = true) => {
    const r = rows()[i];
    if (!r) return;
    setSelectedId(r.id);
    if (scroll) virt.scrollToIndex(i);
  };
  const openDetail = () => {
    if (narrow()) setView("detail");
    queueMicrotask(() => detail?.focus());
  };
  const onListKey = (e: KeyboardEvent) => {
    const n = rows().length;
    const a = activeIndex();
    const page = Math.max(1, Math.floor((scrollEl()?.clientHeight || props.initialRect?.height || 400) / ROW_HEIGHT) - 1);
    let next = -1;
    switch (e.key) {
      case "ArrowDown": next = Math.min(n - 1, a + 1); break;
      case "ArrowUp": next = Math.max(0, a - 1); break;
      case "Home": next = 0; break;
      case "End": next = n - 1; break;
      case "PageDown": next = Math.min(n - 1, a + page); break;
      case "PageUp": next = Math.max(0, a - page); break;
      case "Enter":
        e.preventDefault();
        return openDetail();
      default:
        return;
    }
    e.preventDefault();
    if (n > 0) choose(next);
  };
  // "/" focuses the search from anywhere in the view except a text field. Bare characters cannot be global shortcuts (keymap.chordProblem), so there is no clash.
  const onRootKey = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement;
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
    e.preventDefault();
    e.stopPropagation();
    search?.focus();
  };

  const copyText = async (id: string, body: string) => {
    try {
      await navigator.clipboard.writeText(body);
      setCopiedId(id);
      setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1600);
    } catch {
      // Clipboard may be unavailable; the text stays selectable.
    }
  };

  const licenseOptions = () => {
    const d = data();
    return [{ value: "", label: t("licenses.filter.all", { count: d?.components.length ?? 0 }) }, ...(d?.groups ?? []).map((g) => ({ value: g.id, label: `${g.id} (${g.count})` }))];
  };
  const kindOptions = () => (["all", "rust", "npm", "fonts"] as const).map((v) => ({ value: v, label: t(`licenses.kind.${v}`) }));
  const clearFilters = () => {
    setQuery("");
    setLicense("");
    setKind("all");
    search?.focus();
  };

  const errorState = () => {
    const s = index();
    return s.status === "error" ? s : undefined;
  };

  const DetailBody = (p: { c: Component }) => {
    const c = () => p.c;
    const isProject = () => c().id === PROJECT_ID;
    const alts = () => alternatives(c());
    return (
      <>
        <header class="lic__head">
          <h3 class="lic__name">
            {c().name}
            <Show when={c().version}>
              <span class="lic__version" dir="ltr">{c().version}</span>
            </Show>
          </h3>
          <ul class="lic__badges" dir="ltr">
            <For each={c().chosen}>
              {(id) => (
                <li>
                  <Badge tone="accent" title={t("licenses.chosen")}>{id}</Badge>
                </li>
              )}
            </For>
            <For each={alts()}>
              {(id) => (
                <li>
                  <Badge tone="neutral" title={t("licenses.alternative")}>{id}</Badge>
                </li>
              )}
            </For>
          </ul>
          <Show when={c().optional || !c().distributed || c().generic}>
            <ul class="lic__flags">
              <Show when={c().optional}>
                <li><Badge tone="info" icon={FileText}>{t("licenses.optionalFeature")}</Badge></li>
              </Show>
              <Show when={!c().distributed}>
                <li><Badge tone="warn">{t("licenses.notBundled")}</Badge></li>
              </Show>
              <Show when={c().generic}>
                <li><Badge tone="neutral">{t("licenses.generic")}</Badge></li>
              </Show>
            </ul>
          </Show>
        </header>
        <Show when={!c().distributed}>
          <p class="lic__note">{t("licenses.notBundledText")}</p>
        </Show>
        <Show when={isProject()}>
          <div class="lic__notice">
            <p>{t("about.licenseNotice", { product: ABOUT.product })}</p>
            <Button size="sm" variant="secondary" iconRight={ExternalLink} onClick={() => openLink(ABOUT.license.url)}>{t("about.license.online")}</Button>
          </div>
        </Show>
        <Show when={c().note && !isProject()}>
          <p class="lic__note" dir="ltr">{c().note}</p>
        </Show>
        <Show when={c().copyright.length}>
          <section class="lic__section" aria-label={t("licenses.copyright")}>
            <h4 class="lic__label">{t("licenses.copyright")}</h4>
            <ul class="lic__copyright" dir="ltr">
              <For each={c().copyright}>{(line) => <li>{line}</li>}</For>
            </ul>
          </section>
        </Show>
        <Show when={c().sourceUrl ?? c().homepage ?? (isProject() ? data()?.project.sourceUrl : undefined)}>
          {(u) => <ExternalLinkRow url={u()} label={t("licenses.source")} extraHosts={extraHosts()} />}
        </Show>
        <Show when={c().textIds.length > 0}>
          <TextBlocks ids={c().textIds} />
        </Show>
      </>
    );
  };

  const TextBlocks = (p: { ids: string[] }) => (
    <div class="lic__texts">
      {(() => {
        const s = texts();
        if (s.status === "error") {
          return (
            <div class="lic__inline-error" role="alert">
              <span>{t(s.kind === "schema" ? "licenses.error.schema" : "licenses.error.texts")}</span>
              <Button size="sm" variant="secondary" onClick={loadText}>{t("licenses.retry")}</Button>
            </div>
          );
        }
        if (s.status !== "ready") {
          return (
            <div class="lic__skeleton" aria-busy="true">
              <Skeleton variant="text" height={12} width="40%" />
              <Skeleton variant="rect" height={120} />
            </div>
          );
        }
        return (
          <For each={p.ids}>
            {(id) => (
              <Show when={s.data.texts[id]}>
                {(txt) => (
                  <section class="lic__text-block">
                    <div class="lic__text-head">
                      <h4 class="lic__label" dir="ltr">{txt().title}</h4>
                      <Button size="sm" variant="ghost" icon={copiedId() === id ? Check : Copy} onClick={() => void copyText(id, txt().body)}>
                        {copiedId() === id ? t("licenses.copied") : t("licenses.copy")}
                      </Button>
                    </div>
                    <pre class="lic__text" dir="ltr" tabIndex={0}>{txt().body}</pre>
                  </section>
                )}
              </Show>
            )}
          </For>
        );
      })()}
    </div>
  );

  return (
    <div ref={root} class="lic" data-narrow={narrow() ? "" : undefined} data-view={view()} onKeyDown={onRootKey}>
      <Show when={!errorState()}>
        <div class="lic__toolbar">
          <Input
            ref={search}
            size="sm"
            type="search"
            data-autofocus
            wrapperClass="lic__search"
            leading={<Search size={14} aria-hidden="true" />}
            placeholder={t("licenses.search")}
            aria-label={t("licenses.searchAria")}
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" && rows().length) {
                e.preventDefault();
                listEl?.focus();
              }
            }}
          />
          <Select size="sm" aria-label={t("licenses.filterAria")} wrapperClass="lic__select" options={licenseOptions()} value={license()} onChange={setLicense} />
          <SegmentedControl size="sm" aria-label={t("licenses.kindAria")} options={kindOptions()} value={kind()} onChange={setKind} />
          <span class="lic__count" aria-live="polite" aria-atomic="true">
            <Show when={shownCount() !== null}>{t("licenses.results", { count: shownCount()! })}</Show>
          </span>
        </div>
      </Show>

      <Show when={errorState()}>
        {(e) => (
          <EmptyState
            tone="danger"
            title={t(e().kind === "schema" ? "licenses.error.schema" : "licenses.error.load")}
            description={t("licenses.fallbackHint")}
            action={
              <>
                <Button variant="secondary" onClick={loadData}>{t("licenses.retry")}</Button>
                <Show when={linkAction(ABOUT.source ?? "")}>
                  {(l) => (
                    <Button variant="ghost" iconRight={ExternalLink} onClick={() => openLink(l().url)}>{t("licenses.fallback")}</Button>
                  )}
                </Show>
              </>
            }
          />
        )}
      </Show>

      <Show when={index().status === "loading"}>
        <div class="lic__loading" aria-busy="true">
          <LiveRegion message={t("licenses.loading")} />
          <For each={[0, 1, 2, 3, 4, 5, 6, 7]}>
            {() => (
              <div class="lic__skel-row">
                <Skeleton variant="text" height={12} width="55%" />
                <Skeleton variant="text" height={10} width="30%" />
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={data()}>
        <Show
          when={rows().length > 0}
          fallback={
            <EmptyState
              icon={Search}
              title={t("licenses.empty", { query: query().trim() || "…" })}
              action={<Button variant="secondary" onClick={clearFilters}>{t("licenses.clear")}</Button>}
            />
          }
        >
          <div class="lic__panes">
            <Show when={!narrow() || view() === "list"}>
              <div
                ref={(el) => {
                  listEl = el;
                  // Handed to the virtualizer once attached: it measures the element on assignment, and a detached one is 0x0.
                  queueMicrotask(() => setScrollEl(el.isConnected ? el : null));
                }}
                class="lic__list"
                role="listbox"
                tabIndex={0}
                aria-label={t("licenses.listAria")}
                aria-activedescendant={selected() ? optionId(selected()!.id) : undefined}
                onKeyDown={onListKey}
              >
                <div class="lic__list-inner" style={{ height: `${virt.getTotalSize()}px` }}>
                  <For each={items()}>
                    {(v) => {
                      const row = () => rows()[v.index];
                      return (
                        <Show when={row()}>
                          {(r) => (
                            <div
                              id={optionId(r().id)}
                              class="lic__row"
                              role="option"
                              aria-selected={r().id === selected()?.id}
                              aria-setsize={rows().length}
                              aria-posinset={v.index + 1}
                              data-pinned={r().id === PROJECT_ID ? "" : undefined}
                              style={{ height: `${v.size}px`, transform: `translateY(${v.start}px)` }}
                              onClick={() => {
                                choose(v.index, false);
                                if (narrow()) setView("detail");
                              }}
                            >
                              <span class="lic__row-main">
                                <Show when={r().id === PROJECT_ID}>
                                  <ShieldCheck size={14} aria-hidden="true" />
                                </Show>
                                <span class="lic__row-name">{r().id === PROJECT_ID ? t("licenses.project") : r().name}</span>
                                <Show when={r().version}>
                                  <span class="lic__row-version" dir="ltr">{r().version}</span>
                                </Show>
                              </span>
                              <span class="lic__row-sub" dir="ltr">{r().chosen.join(" · ")}</span>
                            </div>
                          )}
                        </Show>
                      );
                    }}
                  </For>
                </div>
              </div>
            </Show>
            <Show when={!narrow() || view() === "detail"}>
              <section ref={detail} class="lic__detail" role="region" aria-label={t("licenses.detailAria")} tabIndex={-1}>
                <Show when={narrow()}>
                  <Button class="lic__back" size="sm" variant="ghost" icon={ArrowLeft} onClick={() => { setView("list"); queueMicrotask(() => listEl?.focus()); }}>{t("licenses.back")}</Button>
                </Show>
                <Show when={selected()} keyed>
                  {(c) => <DetailBody c={c} />}
                </Show>
              </section>
            </Show>
          </div>
        </Show>
      </Show>
    </div>
  );
}

/** The open-source licenses view ((design notes: licensing-spec) F2). Mounted lazily by LicensesHost on first `openLicenses()`. */
export default function LicensesDialog(props: LicensesDialogProps) {
  return (
    <Dialog open={licensesState().open} onClose={closeLicenses} title={t("licenses.title")} size="xl" class="lic-dialog">
      <Body {...props} />
    </Dialog>
  );
}
