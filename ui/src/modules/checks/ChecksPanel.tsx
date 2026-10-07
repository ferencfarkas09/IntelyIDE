import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { repoName } from "../../store/actions";
import { checkedFiles } from "../../store/selection";
import { workspace } from "../../store/workspace";
import { Badge, Button, ChevronDown, Icon, ListChecks, Play, RepoBadge, Square, Switch, TriangleAlert } from "../../ui-kit";
import { parseAnsi } from "../run/ansi";
import { checksApi } from "./api";
import { countRuns, formatDuration, statusLabel, statusTone, summaryText } from "./logic";
import { logOf, runCheck, runOf, runs, stopCheck, wireChecks } from "./store";
import { beforeCommit, setBeforeCommit } from "./toggle";
import type { CheckInfo, ProcessAccess } from "./types";
import "./checks.css";

interface Target {
  repoId: string;
  paths: string[];
}

/** The ticked files per repo; only repos with ticks have anything to check. */
function useTargets() {
  return createMemo<Target[]>(
    () => (workspace()?.repos ?? []).map((r) => ({ repoId: r.id, paths: [...checkedFiles(r.id)] })).filter((t) => t.paths.length > 0),
    [],
    { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
}

function OutputView(props: { runId: string }) {
  let box: HTMLDivElement | undefined;
  const lines = createMemo(() => logOf(props.runId).slice(-400));
  createEffect(on(lines, () => queueMicrotask(() => box && void (box.scrollTop = box.scrollHeight))));
  return (
    <div class="chk__out" ref={(el: HTMLDivElement) => (box = el)} role="log" aria-label={t("checks.out.aria")} tabIndex={0}>
      <Show when={lines().length} fallback={<div class="chk__line chk__line--dim">{t("checks.out.empty")}</div>}>
        <For each={lines()}>
          {(l) => (
            <div class="chk__line">
              <For each={parseAnsi(l)}>
                {(seg) => (
                  <span classList={{ "run-seg--bold": seg.bold, "run-seg--dim": seg.dim, "run-seg--underline": seg.underline }} style={{ color: seg.fg, "background-color": seg.bg }}>
                    {seg.text}
                  </span>
                )}
              </For>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

function RepoChecks(props: { target: Target; access: ProcessAccess | undefined }) {
  const [checks, setChecks] = createSignal<CheckInfo[] | undefined>(undefined);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [open, setOpen] = createSignal<string | undefined>(undefined);
  const key = () => JSON.stringify(props.target);
  let token = 0;
  createEffect(
    on(key, () => {
      const mine = ++token;
      checksApi()
        .discover(props.target.repoId, props.target.paths)
        .then((c) => mine === token && (setChecks(c), setError(undefined)))
        .catch((e) => mine === token && (setChecks([]), setError(e?.message ?? String(e))));
    }),
  );
  const repo = () => workspace()?.repos.find((r) => r.id === props.target.repoId);
  const counts = () => countRuns((checks() ?? []).flatMap((c) => runOf(props.target.repoId, c.id) ?? []));
  const startable = () => props.access?.startable !== false;
  return (
    <div class="chk__repo">
      <div class="chk__repohead">
        <Show when={repo()}>{(r) => <RepoBadge color={r().color} badge={r().badge} size={16} />}</Show>
        <span class="ui-truncate chk__reponame">{repoName(props.target.repoId)}</span>
        <span class="chk__spacer" />
        <Show when={summaryText(counts())}>
          <Badge tone={counts().failed ? "danger" : counts().running ? "info" : "ok"} size="sm">
            {summaryText(counts())}
          </Badge>
        </Show>
      </div>
      <Show when={error()}>
        <p class="chk__error" role="alert">{error()}</p>
      </Show>
      <Show when={checks()?.length === 0 && !error()}>
        <p class="chk__hint">{t("checks.none")}</p>
      </Show>
      <For each={checks()}>
        {(c) => {
          const run = () => runOf(props.target.repoId, c.id);
          const running = () => run()?.status === "running";
          return (
            <div class="chk__row" data-check={c.id} data-status={run()?.status}>
              <div class="chk__main">
                <span class="chk__label ui-truncate" title={c.label}>{c.label}</span>
                <span class="chk__runner ui-mono ui-truncate" title={c.runner}>{c.runner}</span>
                <Show when={c.note}>
                  <span class="chk__note">{c.note}</span>
                </Show>
                <Show when={c.disabled}>
                  <span class="chk__note">{c.disabled}</span>
                </Show>
              </div>
              <Show when={run()}>
                {(r) => (
                  <button type="button" class="chk__chip" data-tone={statusTone(r().status)} aria-expanded={open() === c.id} onClick={() => setOpen(open() === c.id ? undefined : c.id)} title={t("checks.showOutput")}>
                    {statusLabel(r().status)}
                    <Show when={r().status !== "running" && r().durationMs}> <span class="ui-tnum">{formatDuration(r().durationMs)}</span></Show>
                  </button>
                )}
              </Show>
              <Show
                when={running()}
                fallback={
                  <Button size="sm" variant="secondary" icon={Play} disabled={!!c.disabled || !startable()} onClick={() => (setOpen(c.id), void runCheck(props.target.repoId, c.id, props.target.paths))} aria-label={t("checks.runName", { name: c.label })}>
                    {t("checks.run")}
                  </Button>
                }
              >
                <Button size="sm" variant="ghost" icon={Square} onClick={() => void stopCheck(run()!.id)} aria-label={t("checks.stopName", { name: c.label })}>
                  {t("checks.stop")}
                </Button>
              </Show>
              <Show when={open() === c.id && run()}>{(r) => <OutputView runId={r().id} />}</Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}

/** The pre-commit checks panel in the Commit tool window: human-started checks for the ticked files. */
export default function ChecksPanel() {
  const targets = useTargets();
  // Collapsed until asked for: the block must not push the Changes list out of a short window.
  const [collapsed, setCollapsed] = createSignal(true);
  const [access, setAccess] = createSignal<ProcessAccess | undefined>(undefined);
  onMount(() => {
    wireChecks();
    const refresh = () => void checksApi().access().then(setAccess).catch(() => {});
    refresh();
    const timer = setInterval(refresh, 4000);
    onCleanup(() => clearInterval(timer));
  });
  const all = createMemo(() => countRuns(Object.values(runs())));
  return (
    <Show when={targets().length > 0}>
      <section class="chk" aria-label={t("checks.panel.aria")}>
        <header class="chk__head">
          <button type="button" class="chk__toggle" aria-expanded={!collapsed()} onClick={() => setCollapsed(!collapsed())}>
            <span class="chk__chev" data-collapsed={collapsed() ? "" : undefined}><Icon icon={ChevronDown} size={14} /></span>
            <Icon icon={ListChecks} size={14} />
            <h3 class="chk__title">{t("checks.name")}</h3>
          </button>
          <Show when={summaryText(all())} fallback={<span class="chk__hint ui-tnum">{t("checks.repoCount", { n: targets().length })}</span>}>
            <Badge tone={all().failed ? "danger" : all().running ? "info" : "ok"} size="sm">{summaryText(all())}</Badge>
          </Show>
          <span class="chk__spacer" />
          <Switch checked={beforeCommit()} onChange={setBeforeCommit} size="sm" label={t("checks.beforeCommit")} aria-label={t("checks.beforeAria")} />
        </header>
        <Show when={!collapsed()}>
          <div class="chk__body">
            <Show when={access() && !access()!.startable}>
              <p class="chk__warn" role="status">
                <Icon icon={TriangleAlert} size={12} /> {access()!.reason ?? t("checks.noProcesses")}
              </p>
            </Show>
            <Show when={beforeCommit()}>
              <p class="chk__hint">{t("checks.beforeHint")}</p>
            </Show>
            <For each={targets()}>{(tg) => <RepoChecks target={tg} access={access()} />}</For>
          </div>
        </Show>
      </section>
    </Show>
  );
}
