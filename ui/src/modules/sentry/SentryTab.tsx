import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { openSettings } from "../../platform/settings";
import { agentRows } from "../../store/agents";
import { ArrowLeft, Badge, Bug, Button, CircleCheck, Copy, EmptyState, ExternalLink, Eye, IconButton, Input, RefreshCw, RotateCcw, Search, Select, Skeleton, Sparkles, SplitButton, toast } from "../../ui-kit";
import { lazyLabels } from "../../components/lazyLabels";
import { fixIssue } from "../intelyfix/fix";
import { fixPrefs, loadFixPrefs } from "../intelyfix/prefs";
import { fixPrompt } from "../intelyfix/prompt";
import { pickFixRepos } from "../intelyfix/repos";
import { repos } from "../../store/workspace";
import { sentryApi } from "./api";
import { agoLabel, initials, shortCount, whenLabel } from "./format";
import { fixStateOf, links, resolveLinked, runsOf, showRun, startLinkWatcher } from "./links";
import { ASSIGNEES, levelTone, PERIODS, SORTS, STATUSES } from "./logic";
import { assignees, assignMe, assignTo, detail, detailLoading, detailProblem, filters, issues, loadAssignees, loadMore, loaded, loadProjects, loadStatus, loading, loadingMore, nextCursor, problem, projects, reload, select, selectedId, setFilters, setIssueStatus, status } from "./store";
import type { AssigneeFilter, PeriodFilter, SentryException, SentryIssue, SentryProblem, SortFilter, StatusFilter } from "./types";
import "./sentry.css";

const STATUS_LABEL = lazyLabels<StatusFilter>({ unresolved: "sentry.status.unresolved", resolved: "sentry.status.resolved", ignored: "sentry.status.ignored", all: "sentry.status.all" });
const PERIOD_LABEL = lazyLabels<PeriodFilter>({ "24h": "sentry.period.24h", "7d": "sentry.period.7d", "14d": "sentry.period.14d", "30d": "sentry.period.30d", "90d": "sentry.period.90d" });
const SORT_LABEL = lazyLabels<SortFilter>({ date: "sentry.sort.date", freq: "sentry.sort.freq", new: "sentry.sort.new", user: "sentry.sort.user" });
const ASSIGNEE_LABEL = lazyLabels<AssigneeFilter>({ any: "intelyfix.assignee.any", unassigned: "intelyfix.assignee.unassigned", me: "intelyfix.assignee.me" });
const RUN_LABEL = lazyLabels<"running" | "needsYou" | "done" | "error" | "gone">({ running: "intelyfix.run.running", needsYou: "intelyfix.run.needsYou", done: "intelyfix.run.done", error: "intelyfix.run.error", gone: "intelyfix.run.gone" });

/** The issue whose fix is being started (reading it, assigning it, starting the run): its buttons wait. */
const [fixing, setFixing] = createSignal<string | undefined>(undefined);

/** Fix, once at a time; a failure to read the issue is told, everything after that is a notice or the New run dialog. */
async function startFix(id: string, opts?: { review?: boolean }): Promise<void> {
  if (fixing()) return;
  setFixing(id);
  try {
    await fixIssue(id, opts);
  } catch (e) {
    toast.error(t("sentry.fix.failed"), problemText(e as SentryProblem));
  } finally {
    setFixing(undefined);
  }
}

/** The prompt the fix would start with, on the clipboard, for the issue in the detail (to use in any other tool). */
async function copyPrompt(id: string): Promise<void> {
  try {
    await loadFixPrefs();
    const d = await sentryApi().issue(id);
    const found = pickFixRepos(d.issue.project?.slug, fixPrefs().repoMap, repos());
    const text = fixPrompt({ detail: d, template: fixPrefs().template, repos: found && { primary: found.primary.map((r) => r.name), related: found.related.map((r) => r.name) } });
    await navigator.clipboard.writeText(text);
    toast.success(t("intelyfix.promptCopied", { id: d.issue.shortId }));
  } catch (e) {
    toast.error(t("intelyfix.promptFailed"), (e as { message?: string })?.message);
  }
}

/** What a failure says, in words the user can act on. */
export function problemText(p: SentryProblem): string {
  switch (p.code) {
    case "unauthorized": return t("sentry.problem.unauthorized");
    case "forbidden": return t("sentry.problem.forbidden", { message: p.message });
    case "notConfigured": return t("sentry.problem.notConfigured");
    case "notFound": return t("sentry.problem.notFound");
    case "rateLimited": return p.retryAfterSeconds ? t("sentry.problem.rateLimitedIn", { s: p.retryAfterSeconds }) : t("sentry.problem.rateLimited");
    case "network": return t("sentry.problem.network", { message: p.message });
    case "invalidBaseUrl": return p.message;
    case "testJail": return t("sentry.problem.testJail");
    default: return p.message;
  }
}

/** The small badges of a row: what Sentry says about the issue (regressed, escalating, new, high priority) and where its fix stands. */
function RowChips(props: { issue: SentryIssue }) {
  const i = () => props.issue;
  const state = () => fixStateOf(i().id);
  return (
    <>
      <Show when={state() === "fixing"}><Badge size="sm" tone="info">{t("intelyfix.chip.fixing")}</Badge></Show>
      <Show when={state() === "ready"}><Badge size="sm" tone="ok">{t("intelyfix.chip.ready")}</Badge></Show>
      <Show when={state() === "triage"}><Badge size="sm" tone="warn">{t("intelyfix.chip.triage")}</Badge></Show>
      <Show when={i().status === "unresolved" && i().substatus === "regressed"}><Badge size="sm" tone="danger">{t("intelyfix.chip.regressed")}</Badge></Show>
      <Show when={i().status === "unresolved" && i().substatus === "escalating"}><Badge size="sm" tone="warn">{t("intelyfix.chip.escalating")}</Badge></Show>
      <Show when={i().status === "unresolved" && i().substatus === "new"}><Badge size="sm" tone="info">{t("intelyfix.chip.new")}</Badge></Show>
      {/* a regression, an escalation and a new issue already say it is urgent */}
      <Show when={i().status === "unresolved" && i().priority === "high" && !["regressed", "escalating", "new"].includes(i().substatus ?? "")}><Badge size="sm" tone="warn">{t("intelyfix.chip.high")}</Badge></Show>
    </>
  );
}

function IssueRow(props: { issue: SentryIssue; now: number; active: boolean }) {
  const i = () => props.issue;
  return (
    <li class="sentry-item">
      <button type="button" class="sentry-row" data-active={props.active ? "" : undefined} data-status={i().status} aria-current={props.active ? "true" : undefined} onClick={() => void select(i().id)}>
        <span class="sentry-row__dot" data-tone={levelTone(i().level)} title={i().level} aria-hidden="true" />
        <span class="sentry-row__main">
          <span class="sentry-row__title">{i().title}</span>
          <span class="sentry-row__culprit ui-mono">{i().culprit}</span>
          <span class="sentry-row__meta">
            <Show when={i().project}>{(p) => <Badge size="sm">{p().slug}</Badge>}</Show>
            <span class="sentry-row__id ui-tnum">{i().shortId}</span>
            <Show when={i().status !== "unresolved"}>
              <Badge size="sm" tone={i().status === "resolved" ? "ok" : "neutral"}>{STATUS_LABEL[i().status as StatusFilter] ?? i().status}</Badge>
            </Show>
            <Show when={i().isUnhandled}>
              <Badge size="sm" tone="warn">{t("sentry.unhandled")}</Badge>
            </Show>
            <RowChips issue={i()} />
          </span>
        </span>
        <span class="sentry-row__nums ui-tnum">
          <span title={t("sentry.events")}>{shortCount(i().count)}</span>
          <span class="sentry-row__users" title={t("sentry.users")}>{shortCount(i().userCount)}</span>
          <span class="sentry-row__seen">{agoLabel(i().lastSeen, props.now)}</span>
        </span>
        <Show when={i().assignedTo} fallback={<span class="sentry-row__who" data-empty="" aria-label={t("sentry.unassigned")} />}>
          {(a) => <span class="sentry-row__who" title={a().name} aria-label={t("sentry.assignedTo", { name: a().name })}>{initials(a().name)}</span>}
        </Show>
      </button>
      <Show when={i().status === "unresolved"}>
        <IconButton class="sentry-item__fix" icon={Sparkles} size="sm" label={t("intelyfix.fixRow", { id: i().shortId })} loading={fixing() === i().id} disabled={!!fixing() && fixing() !== i().id} onClick={() => void startFix(i().id)} />
      </Show>
    </li>
  );
}

/** One run started from the issue: how it stands, what it said at its end, and a way into it. */
function RunLine(props: { agentId: string }) {
  const row = () => agentRows().find((r) => r.agentId === props.agentId);
  const link = () => links()[props.agentId];
  const state = () => (row()?.status ?? "gone") as "running" | "needsYou" | "done" | "error" | "gone";
  return (
    <li class="sentry-runs__run">
      <Badge size="sm" tone={state() === "done" ? "ok" : state() === "error" ? "danger" : state() === "needsYou" ? "warn" : "neutral"}>{RUN_LABEL[state()]}</Badge>
      <Show when={link()?.verdict}>{(v) => <Badge size="sm" tone={v() === "fixed" ? "ok" : "warn"}>{t(v() === "fixed" ? "intelyfix.verdict.fixed" : "intelyfix.verdict.needs-triage")}</Badge>}</Show>
      <span class="sentry-runs__title">{row()?.title ?? link()?.title}</span>
      <Show when={link()?.cause}>{(c) => <span class="sentry-runs__cause">{t("intelyfix.run.cause", { cause: c() })}</span>}</Show>
      <Show when={row()}><Button size="sm" variant="ghost" onClick={() => showRun(props.agentId)}>{t("intelyfix.openRun")}</Button></Show>
    </li>
  );
}

/** "Assign to...": me, nobody, a person or a team of the organization. The placeholder says who has it now. */
function AssignControl(props: { issue: SentryIssue }) {
  const [busy, setBusy] = createSignal(false);
  const options = createMemo(() => [
    { value: "me", label: t("intelyfix.assign.me") },
    { value: "none", label: t("intelyfix.assign.nobody") },
    ...assignees().map((a) => ({ value: `${a.kind}:${a.id}`, label: a.email ? t("intelyfix.assign.person", { name: a.name, email: a.email }) : a.name })),
  ]);
  const choose = async (value: string) => {
    setBusy(true);
    try {
      const updated = value === "me" ? await assignMe(props.issue.id) : value === "none" ? await assignTo(props.issue.id, null) : await assignTo(props.issue.id, { kind: value.startsWith("team:") ? "team" : "user", id: value.split(":")[1] });
      toast.success(updated.assignedTo ? t("intelyfix.assigned", { id: props.issue.shortId, name: updated.assignedTo.name }) : t("intelyfix.unassigned", { id: props.issue.shortId }));
    } catch (e) {
      toast.error(t("sentry.assign.failed"), problemText(e as SentryProblem));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Select
      size="sm"
      wrapperClass="sentry-assign"
      aria-label={t("intelyfix.assignTo")}
      placeholder={props.issue.assignedTo ? t("sentry.assignedTo", { name: props.issue.assignedTo.name }) : t("intelyfix.assignTo")}
      options={options()}
      value={undefined}
      disabled={busy()}
      onChange={(v) => void choose(v)}
    />
  );
}

function Frames(props: { ex: SentryException }) {
  const frames = () => props.ex.frames.slice().reverse();
  return (
    <div class="sentry-stack">
      <div class="sentry-stack__head">
        <span class="sentry-stack__kind ui-mono">{props.ex.kind}</span>
        <span class="sentry-stack__value">{props.ex.value}</span>
      </div>
      <ol class="sentry-frames">
        <For each={frames()}>
          {(f, idx) => (
            <li class="sentry-frame" data-app={f.inApp ? "" : undefined}>
              <div class="sentry-frame__head ui-mono">
                <span class="sentry-frame__file">{f.filename || "?"}{f.line ? `:${f.line}` : ""}</span>
                <span class="sentry-frame__fn">{f.function}</span>
                <Show when={!f.inApp}><span class="sentry-frame__lib">{t("sentry.library")}</span></Show>
              </div>
              <Show when={idx() < 2 && f.context.length}>
                <pre class="sentry-frame__code ui-mono">
                  <For each={f.context}>{(c) => <span class="sentry-frame__line" data-hit={c.line === f.line ? "" : undefined}><span class="sentry-frame__no ui-tnum">{c.line}</span>{c.code}{"\n"}</span>}</For>
                </pre>
              </Show>
            </li>
          )}
        </For>
      </ol>
    </div>
  );
}

function Detail(props: { now: number }) {
  const [busy, setBusy] = createSignal<string | undefined>(undefined);
  onMount(() => void loadAssignees());
  const d = createMemo(() => detail());
  const run = async (what: string, job: () => Promise<unknown>, failed: string) => {
    setBusy(what);
    try {
      await job();
    } catch (e) {
      toast.error(failed, problemText(e as SentryProblem));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div class="sentry-detail" data-testid="sentry-detail">
      <Show when={detailProblem()}>{(p) => <EmptyState tone="danger" size="sm" icon={Bug} title={t("sentry.detail.failed")} description={problemText(p())} />}</Show>
      <Show when={!d() && detailLoading()}>
        <div class="sentry-detail__loading"><Skeleton height={44} /><Skeleton height={120} /><Skeleton height={160} /></div>
      </Show>
      <Show when={d()}>
        {(det) => {
          const i = () => det().issue;
          const resolved = () => i().status === "resolved";
          return (
            <>
              <Button class="sentry-back" size="sm" variant="ghost" icon={ArrowLeft} onClick={() => void select(undefined)}>{t("sentry.back")}</Button>
              <header class="sentry-detail__head">
                <div class="sentry-detail__titles">
                  <h3 class="sentry-detail__title">{i().title}</h3>
                  <div class="sentry-detail__sub ui-mono">{i().culprit}</div>
                  <div class="sentry-detail__chips">
                    <Badge size="sm" tone={levelTone(i().level) === "danger" ? "danger" : levelTone(i().level) === "warn" ? "warn" : "neutral"}>{i().level}</Badge>
                    <Badge size="sm" tone={resolved() ? "ok" : "neutral"}>{STATUS_LABEL[i().status as StatusFilter] ?? i().status}</Badge>
                    <Show when={i().project}>{(p) => <Badge size="sm">{p().slug}</Badge>}</Show>
                    <span class="sentry-row__id ui-tnum">{i().shortId}</span>
                    <Show when={i().assignedTo}>{(a) => <span class="sentry-detail__assignee">{t("sentry.assignedTo", { name: a().name })}</span>}</Show>
                  </div>
                </div>
                <div class="sentry-detail__actions">
                  <Show when={!resolved()}>
                    <SplitButton
                      size="sm"
                      variant="primary"
                      icon={Sparkles}
                      loading={fixing() === i().id}
                      menuLabel={t("intelyfix.fixMore")}
                      onClick={() => void startFix(i().id)}
                      items={[
                        { label: t("intelyfix.fixReview"), icon: Eye, onSelect: () => void startFix(i().id, { review: true }) },
                        { label: t("intelyfix.copyPrompt"), icon: Copy, onSelect: () => void copyPrompt(i().id) },
                      ]}
                    >
                      {t("intelyfix.fix")}
                    </SplitButton>
                  </Show>
                  <AssignControl issue={i()} />
                  <Show
                    when={!resolved()}
                    fallback={<Button size="sm" variant="secondary" icon={RotateCcw} loading={busy() === "status"} onClick={() => void run("status", () => setIssueStatus(i().id, "unresolved"), t("sentry.status.failed"))}>{t("sentry.reopen")}</Button>}
                  >
                    <SplitButton
                      size="sm"
                      variant="secondary"
                      icon={CircleCheck}
                      loading={busy() === "status"}
                      menuLabel={t("intelyfix.resolveMore")}
                      onClick={() => void run("status", () => resolveLinked({ issueId: i().id, shortId: i().shortId }), t("sentry.status.failed"))}
                      items={[{ label: t("intelyfix.resolveNext"), icon: CircleCheck, onSelect: () => void run("status", () => resolveLinked({ issueId: i().id, shortId: i().shortId }, { nextRelease: true }), t("sentry.status.failed")) }]}
                    >
                      {t("sentry.resolve")}
                    </SplitButton>
                  </Show>
                  <IconButton icon={ExternalLink} size="sm" label={t("sentry.open")} onClick={() => void sentryApi().openExternal(i().permalink).catch((e) => toast.error(t("sentry.open.failed"), problemText(e as SentryProblem)))} />
                </div>
              </header>
              <dl class="sentry-facts ui-tnum">
                <div><dt>{t("sentry.events")}</dt><dd>{i().count}</dd></div>
                <div><dt>{t("sentry.users")}</dt><dd>{i().userCount}</dd></div>
                <div><dt>{t("sentry.firstSeen")}</dt><dd>{whenLabel(i().firstSeen) || "–"}</dd></div>
                <div><dt>{t("sentry.lastSeen")}</dt><dd>{whenLabel(i().lastSeen) || "–"}</dd></div>
              </dl>
              <Show when={runsOf(i().id).length}>
                <section class="sentry-runs" aria-label={t("intelyfix.runs")}>
                  <h4 class="sentry-detail__h">{t("intelyfix.runs")}</h4>
                  <ul class="sentry-runs__list">
                    <For each={runsOf(i().id).slice().reverse()}>{(id) => <RunLine agentId={id} />}</For>
                  </ul>
                </section>
              </Show>
              <Show when={det().event} fallback={<p class="sentry-detail__note">{t("sentry.noEvent")}</p>}>
                {(ev) => (
                  <>
                    <div class="sentry-tags">
                      <Show when={ev().release}>{(r) => <Badge size="sm">{t("sentry.release", { release: r() })}</Badge>}</Show>
                      <For each={ev().tags.filter((x) => x.key !== "release").slice(0, 12)}>{(tag) => <Badge size="sm" title={`${tag.key}: ${tag.value}`}>{tag.key}: {tag.value}</Badge>}</For>
                    </div>
                    <Show when={ev().requestUrl}>{(u) => <p class="sentry-detail__note ui-mono">{u()}</p>}</Show>
                    <For each={ev().exceptions.slice().reverse()}>{(ex) => <Frames ex={ex} />}</For>
                    <Show when={ev().breadcrumbs.length}>
                      <h4 class="sentry-detail__h">{t("sentry.crumbs")}</h4>
                      <ul class="sentry-crumbs">
                        <For each={ev().breadcrumbs.slice().reverse()}>
                          {(b) => <li><span class="sentry-crumbs__cat ui-mono">{b.category || b.level}</span><span class="sentry-crumbs__msg">{b.message}</span></li>}
                        </For>
                      </ul>
                    </Show>
                  </>
                )}
              </Show>
            </>
          );
        }}
      </Show>
    </div>
  );
}

/** The IntelyFIX tab: the Sentry issues of the organization with filters, search, counts and times, one issue with its newest event, and one-click Fix. */
export default function SentryTab() {
  const [now, setNow] = createSignal(Date.now());
  const [words, setWords] = createSignal(filters().query);
  let typing: ReturnType<typeof setTimeout> | undefined;
  onMount(() => {
    startLinkWatcher();
    void loadFixPrefs();
    void (async () => {
      const s = await loadStatus();
      if (s?.configured) {
        void loadProjects();
        await reload();
      }
    })();
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => (clearInterval(tick), clearTimeout(typing)));
  });
  /** A filter that is picked takes effect at once; the words of a search wait for a pause in the typing. */
  const apply = (patch: Parameters<typeof setFilters>[0]) => (setFilters(patch), void reload());
  const search = (text: string) => {
    setWords(text);
    clearTimeout(typing);
    typing = setTimeout(() => apply({ query: text }), 350);
  };
  const options = <K extends string>(keys: readonly K[], names: Record<K, string>) => keys.map((k) => ({ value: k, label: names[k] }));
  const projectOptions = createMemo(() => [{ value: "", label: t("sentry.allProjects") }, ...projects().map((p) => ({ value: p.id, label: p.name }))]);
  return (
    <div class="sentry-tab" data-testid="sentry-tab">
      <Show
        when={status()?.configured}
        fallback={
          <Show when={loaded() || status()} fallback={<div class="sentry-setup"><Skeleton height={60} /></div>}>
            <div class="sentry-setup">
              <EmptyState icon={Bug} title={t("sentry.setup.title")} description={t("sentry.setup.desc")} />
              <div class="sentry-setup__actions"><Button variant="primary" onClick={() => openSettings("sentry")}>{t("sentry.setup.button")}</Button></div>
            </div>
          </Show>
        }
      >
        <header class="sentry-bar">
          <Input class="sentry-bar__search" size="sm" leading={<Search size={14} />} placeholder={t("sentry.search")} aria-label={t("sentry.search")} value={words()} onInput={(e) => search(e.currentTarget.value)} />
          <Select size="sm" aria-label={t("sentry.filter.status")} options={options(STATUSES, STATUS_LABEL)} value={filters().status} onChange={(v) => apply({ status: v })} />
          <Select size="sm" aria-label={t("sentry.filter.period")} options={options(PERIODS, PERIOD_LABEL)} value={filters().period} onChange={(v) => apply({ period: v })} />
          <Select size="sm" aria-label={t("sentry.filter.sort")} options={options(SORTS, SORT_LABEL)} value={filters().sort} onChange={(v) => apply({ sort: v })} />
          <Select size="sm" aria-label={t("intelyfix.filter.assignee")} options={options(ASSIGNEES, ASSIGNEE_LABEL)} value={filters().assignee ?? "any"} onChange={(v) => apply({ assignee: v })} />
          <Select size="sm" aria-label={t("sentry.filter.project")} options={projectOptions()} value={filters().project ?? ""} onChange={(v) => apply({ project: v || null })} />
          <IconButton icon={RefreshCw} size="sm" label={t("sentry.refresh")} loading={loading()} onClick={() => void reload()} />
        </header>
        <div class="sentry-body" data-detail={selectedId() ? "" : undefined}>
          <div class="sentry-listcol">
            <Show when={problem()}>{(p) => <EmptyState tone="danger" size="sm" icon={Bug} title={t("sentry.failed")} description={problemText(p())} />}</Show>
            <Show when={!problem() && loaded() && !loading() && issues().length === 0}>
              <EmptyState size="sm" icon={Bug} title={t("sentry.empty")} description={t("sentry.emptyDesc")} />
            </Show>
            <Show when={!loaded() && loading()}>
              <div class="sentry-detail__loading"><Skeleton height={56} /><Skeleton height={56} /><Skeleton height={56} /></div>
            </Show>
            <ul class="sentry-list" data-testid="sentry-list" aria-label={t("sentry.issues")}>
              <For each={issues()}>{(i) => <IssueRow issue={i} now={now()} active={selectedId() === i.id} />}</For>
            </ul>
            <Show when={nextCursor()}>
              <div class="sentry-more"><Button size="sm" variant="secondary" loading={loadingMore()} onClick={() => void loadMore()}>{t("sentry.more")}</Button></div>
            </Show>
          </div>
          <Show when={selectedId()} fallback={<div class="sentry-pick"><EmptyState size="sm" icon={Bug} title={t("sentry.pick")} /></div>}>
            <Detail now={now()} />
          </Show>
        </div>
      </Show>
    </div>
  );
}

