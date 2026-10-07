import { createSignal, For, Show } from "solid-js";
import { fmt, t } from "../../i18n";
import { repoName } from "../../store/actions";
import { Badge, Button, ChevronDown, ChevronRight, CircleAlert, EmptyState, FileSearch, Icon, ListChecks, RefreshCw, Skeleton, Sparkles, Sun, TriangleAlert, toast } from "../../ui-kit";
import { openInspector, openReview } from "../inspector/openers";
import { duration, needsAttention } from "./logic";
import { brief, briefBusy, briefError, loadBrief, summarise, summary, summaryBusy } from "./store";
import type { BriefRun, RepoChange } from "./types";

const STATUS_TONE = { running: "info", done: "ok", failed: "danger", cancelled: "warn" } as const;
const STATUS_KEY = { running: "history.status.running", done: "history.status.done", failed: "history.status.failed", cancelled: "history.status.cancelled" } as const;
const usd = (n: number | undefined): string => (n === undefined ? t("brief.na") : `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`);
const CHANGE_LETTER = { modified: "M", created: "A", deleted: "D" } as const;

function RepoBlock(props: { repo: RepoChange }) {
  const [open, setOpen] = createSignal(false);
  const r = () => props.repo;
  return (
    <li class="bf__repo" data-repo={r().repoId}>
      <button type="button" class="bf__repohead" aria-expanded={open()} disabled={!r().files.length} onClick={() => setOpen(!open())}>
        <Icon icon={open() ? ChevronDown : ChevronRight} size={14} />
        <span class="bf__reponame">{repoName(r().repoId)}</span>
        <Show
          when={!r().note}
          fallback={<span class="bf__muted">{r().note === "noSnapshot" ? t("brief.note.noSnapshot") : t("brief.note.gitUnavailable")}</span>}
        >
          <Show when={r().fileCount} fallback={<span class="bf__muted">{t("brief.noChanges")}</span>}>
            <span class="ui-tnum">{t("brief.files", { n: r().fileCount })}</span>
            <span class="bf__add ui-tnum">+{r().additions}</span>
            <span class="bf__del ui-tnum">−{r().deletions}</span>
          </Show>
        </Show>
      </button>
      <Show when={open()}>
        <ul class="bf__files">
          <For each={r().files}>
            {(f) => (
              <li class="bf__file">
                <span class="bf__letter" data-change={f.change} title={t(`brief.change.${f.change}` as "brief.change.modified")}>{CHANGE_LETTER[f.change]}</span>
                <span class="bf__path ui-mono ui-truncate" title={f.path}>{f.path}</span>
                <span class="bf__add ui-tnum">+{f.additions}</span>
                <span class="bf__del ui-tnum">−{f.deletions}</span>
              </li>
            )}
          </For>
          <Show when={r().fileCount > r().files.length}><li class="bf__muted">{t("brief.more", { n: r().fileCount - r().files.length })}</li></Show>
        </ul>
      </Show>
    </li>
  );
}

function RunCard(props: { run: BriefRun }) {
  const r = () => props.run;
  const params = () => ({ runId: r().runId, title: r().title, role: r().role, repoIds: r().repos.map((x) => x.repoId) });
  const d = () => duration(r().endedMs - r().startedMs);
  return (
    <li class="bf__run" data-run={r().runId} data-attention={needsAttention(r()) ? "" : undefined}>
      <div class="bf__top">
        <span class="bf__title ui-truncate" title={r().title}>{r().title}</span>
        <Badge size="sm" tone={STATUS_TONE[r().status as keyof typeof STATUS_TONE] ?? "neutral"}>{STATUS_KEY[r().status as keyof typeof STATUS_KEY] ? t(STATUS_KEY[r().status as keyof typeof STATUS_KEY]) : r().status}</Badge>
      </div>
      <div class="bf__meta">
        <span>{r().role}</span>
        <span class="ui-mono">{r().model}</span>
        <Show when={r().endedMs > r().startedMs}><span class="ui-tnum">{t("brief.duration", { m: d().minutes, s: d().seconds })}</span></Show>
        <span class="ui-tnum">{t("brief.cost", { cost: usd(r().costUsd) })}</span>
        <Show when={r().tokens > 0}><span class="ui-tnum">{t("brief.tokens", { n: fmt.number(r().tokens, "compact") })}</span></Show>
      </div>
      <ul class="bf__repos" aria-label={t("brief.changes")}>
        <For each={r().repos}>{(repo) => <RepoBlock repo={repo} />}</For>
      </ul>
      <Show when={r().failures.length}>
        <div class="bf__block" data-tone="danger">
          <h4 class="bf__h"><Icon icon={TriangleAlert} size={14} /> {t("brief.failed", { n: r().failureCount })}</h4>
          <ul class="bf__lines"><For each={r().failures}>{(f) => <li><span class="bf__kind">{t(`brief.failure.${f.kind}` as "brief.failure.tool")}</span> {f.text}</li>}</For></ul>
        </div>
      </Show>
      <Show when={r().needsYou.length}>
        <div class="bf__block" data-tone="warn">
          <h4 class="bf__h"><Icon icon={CircleAlert} size={14} /> {t("brief.needs", { n: r().needsYou.length })}</h4>
          <ul class="bf__lines"><For each={r().needsYou}>{(n) => <li><span class="bf__kind">{t(`brief.need.${n.kind}` as "brief.need.permission")}</span> {n.text}</li>}</For></ul>
        </div>
      </Show>
      <div class="bf__acts">
        <Button size="sm" variant="primary" icon={ListChecks} onClick={() => void openReview(params())}>{t("brief.openReview")}</Button>
        <Button size="sm" variant="ghost" icon={FileSearch} onClick={() => void openInspector(params())}>{t("brief.inspect")}</Button>
      </div>
    </li>
  );
}

/** The morning view: what the night produced, from the logs and git, with a one-click way into each run's review. */
export default function BriefView() {
  const b = () => brief();
  const ordered = () => [...(b()?.runs ?? [])].sort((x, y) => Number(needsAttention(y)) - Number(needsAttention(x)) || x.startedMs - y.startedMs);
  const run = async () => {
    const e = await summarise();
    if (e) toast.error(t("brief.toast.summaryFailed"), e);
  };
  return (
    <div class="bf">
      <section class="nq__card nq__head">
        <div class="nq__headtext">
          <h2 class="nq__h"><Icon icon={Sun} size={16} /> {t("brief.title")}</h2>
          <p class="nq__sub">{t("brief.sub")}</p>
        </div>
        <div class="nq__row">
          <Button variant="ghost" icon={RefreshCw} loading={briefBusy()} onClick={() => void loadBrief()}>{t("brief.refresh")}</Button>
          <Button variant="secondary" icon={Sparkles} loading={summaryBusy()} disabled={!b()?.runs.length} onClick={() => void run()} title={t("brief.summarise.hint")}>{t("brief.summarise")}</Button>
        </div>
      </section>

      <Show when={briefError()}><EmptyState size="sm" tone="danger" icon={TriangleAlert} title={t("brief.error")} description={briefError()} /></Show>
      <Show when={!b() && !briefError()}><Skeleton height={80} /></Show>

      <Show when={b()}>
        {(brief) => (
          <>
            <dl class="bf__totals" aria-label={t("brief.totals")}>
              <div><dt>{t("brief.t.runs")}</dt><dd class="ui-tnum">{brief().totals.runs}</dd></div>
              <div data-tone={brief().totals.failed ? "danger" : undefined}><dt>{t("brief.t.failed")}</dt><dd class="ui-tnum">{brief().totals.failed}</dd></div>
              <div data-tone={brief().totals.needsYou ? "warn" : undefined}><dt>{t("brief.t.needs")}</dt><dd class="ui-tnum">{brief().totals.needsYou}</dd></div>
              <div><dt>{t("brief.t.files")}</dt><dd class="ui-tnum">{brief().totals.files}</dd></div>
              <div><dt>{t("brief.t.lines")}</dt><dd class="ui-tnum"><span class="bf__add">+{brief().totals.additions}</span> <span class="bf__del">−{brief().totals.deletions}</span></dd></div>
              <div><dt>{t("brief.t.cost")}</dt><dd class="ui-tnum">{usd(brief().totals.costUsd)}</dd></div>
            </dl>
            <Show when={summary()}>
              <section class="nq__card bf__summary" aria-label={t("brief.summary")}>
                <h3 class="nq__title"><Icon icon={Sparkles} size={14} /> {t("brief.summary")}</h3>
                <p class="bf__summarytext">{summary()}</p>
                <p class="bf__muted">{t("brief.summary.note")}</p>
              </section>
            </Show>
            <Show when={ordered().length} fallback={<EmptyState size="sm" icon={Sun} title={t("brief.empty.title")} description={t("brief.empty.desc")} />}>
              <ul class="bf__runs" aria-label={t("brief.runs.aria")}>
                <For each={ordered()}>{(r) => <RunCard run={r} />}</For>
              </ul>
            </Show>
            <p class="bf__muted">{t("brief.footer")}</p>
          </>
        )}
      </Show>
    </div>
  );
}
