import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import {
  activeSheetRun,
  cancelRun,
  closeSheet,
  latestSheetRun,
  committedNotPushed,
  openPushDialog,
  pullThenPush,
  pushDialogRequest,
  refreshRepo,
  repoName,
  retryRow,
  rowState,
  sheetOpen,
  sheetRows,
  sheetSummary,
  type SheetRow,
} from "../../store/actions";
import { workspace } from "../../store/workspace";
import {
  Badge,
  Button,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Dialog,
  Icon,
  IconButton,
  Info,
  ProgressBar,
  RefreshCw,
  RepoBadge,
  ScrollArea,
  Spinner,
  TriangleAlert,
  X,
  type LucideIcon,
} from "../../ui-kit";
import { t } from "../../i18n";
import { tRich } from "../richText";
import { describeFailure, isTerminal, STATUS_LABEL, statusTone, type RowAction } from "./logic";
import "./results.css";

const shortOid = (oid?: string | null) => oid?.slice(0, 7);

function doneLabel(row: SheetRow, flags: readonly string[]): string {
  if (row.kind === "commit") return t("results.committed");
  return flags.every((f) => f === "=") ? t("results.upToDate") : flags.includes("*") ? t("results.newBranch") : t("results.pushed");
}

function Notice(props: { tone: "warn" | "info"; icon: LucideIcon; children: JSX.Element; action?: JSX.Element }) {
  return (
    <div class="results-notice" data-tone={props.tone}>
      <Icon icon={props.icon} size={14} />
      <div class="results-notice__text">{props.children}</div>
      {props.action}
    </div>
  );
}

/** Streamed output of a repo; follows the tail while lines arrive unless the user scrolled up. */
function Output(props: { row: SheetRow }) {
  const lines = () => rowState(props.row)?.lines ?? [];
  let viewport: HTMLDivElement | undefined;
  let pinned = true;
  createEffect(
    on(
      () => lines().length,
      () => {
        if (viewport && pinned) viewport.scrollTop = viewport.scrollHeight;
      },
    ),
  );
  onMount(() => viewport && (viewport.scrollTop = viewport.scrollHeight));
  return (
    <ScrollArea
      class="results-output"
      ref={(el) => (viewport = el)}
      onScroll={() => viewport && (pinned = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 24)}
      aria-label={t("results.outputOf", { name: repoName(props.row.repoId) })}
      role="log"
      tabIndex={0}
    >
      <Show when={lines().length} fallback={<p class="results-output__empty">{t("results.noOutput")}</p>}>
        <pre class="results-output__pre ui-mono ui-selectable">
          <For each={lines()}>{(line) => <span class="results-output__line" data-stream={line.stream}>{line.text + "\n"}</span>}</For>
        </pre>
      </Show>
    </ScrollArea>
  );
}

function ResultRow(props: { row: SheetRow; onRetryWithoutHooks: (row: SheetRow) => void }) {
  const row = () => props.row;
  const state = () => rowState(row());
  const outcome = () => state()?.outcome;
  const failure = () => outcome()?.failure;
  const status = () => state()?.status ?? "queued";
  const running = () => !isTerminal(status());
  const view = createMemo(() => (failure() ? describeFailure(failure()!.kind, row().kind) : null));
  const hasOutput = () => (state()?.lines.length ?? 0) > 0;
  const [open, setOpen] = createSignal(false);
  // A rejected hook is explained by its output, so show it right away.
  createEffect(on(() => failure()?.kind, (kind) => kind === "hookRejected" && setOpen(true)));
  const repo = () => workspace()?.repos.find((r) => r.id === row().repoId);
  const flags = () => outcome()?.pushResults?.map((r) => r.flag) ?? [];
  const lastLine = () => state()?.lines.at(-1)?.text;
  const localOnly = () =>
    !!committedNotPushed(row().repoId) &&
    ((row().kind === "push" && (status() === "failed" || status() === "cancelled")) || (row().kind === "commit" && row().thenPush && status() === "done" && !pushDialogRequest() && !activeSheetRun()));
  const actions = (): RowAction[] => (view()?.actions ?? (status() === "cancelled" ? ["retry"] : []));

  const act = (action: RowAction) => {
    if (action === "retry") void retryRow(row());
    else if (action === "retryNoHooks") props.onRetryWithoutHooks(row());
    else if (action === "pullThenPush") void pullThenPush(row());
    else void refreshRepo(row().repoId);
  };

  return (
    <li class="results-row" data-status={status()} aria-label={`${repoName(row().repoId)}: ${STATUS_LABEL[status()]}`}>
      <div class="results-row__head">
        <Show when={repo()}>{(r) => <RepoBadge color={r().color} badge={r().badge} size={20} />}</Show>
        <span class="results-row__name ui-truncate">{repoName(row().repoId)}</span>
        <Badge tone={statusTone(status())} icon={status() === "done" ? CircleCheck : status() === "failed" ? CircleAlert : undefined} class="results-row__chip">
          <Show when={running()}>
            <Spinner size={12} />
          </Show>
          {status() === "done" ? doneLabel(row(), flags()) : STATUS_LABEL[status()]}
        </Badge>
      </div>

      <Show when={running() && state()?.percent != null}>
        <ProgressBar value={state()!.percent!} size="sm" aria-label={t(row().kind === "push" ? "results.pushProgress" : "results.commitProgress", { name: repoName(row().repoId) })} />
      </Show>
      <Show when={running() && lastLine()}>
        <p class="results-row__line ui-mono ui-truncate">{lastLine()}</p>
      </Show>

      <Show when={status() === "done"}>
        <p class="results-row__detail ui-truncate">
          <Show when={row().kind === "commit"} fallback={<span class="ui-mono">{row().target ? `${row().target!.remote}/${row().target!.remoteBranch}` : ""}</span>}>
            <Show when={outcome()?.commitOid}>
              <span class="results-row__oid ui-mono">{shortOid(outcome()?.commitOid)}</span>
            </Show>
            <span>{row().commit?.message.split("\n", 1)[0]}</span>
          </Show>
        </p>
      </Show>

      <Show when={failure()}>
        {(f) => (
          <div class="results-row__failure" role="group" aria-label={t("results.failure")}>
            <p class="results-row__failure-title">{view()?.title}</p>
            <p class="results-row__failure-text">{f().message}</p>
            <Show when={view()?.hint}>
              <p class="results-row__hint">{view()?.hint}</p>
            </Show>
          </div>
        )}
      </Show>

      <Show when={(outcome()?.hookModifiedFiles.length ?? 0) > 0}>
        <Notice tone="warn" icon={TriangleAlert}>
          <strong>{t("results.hooksChanged", { n: outcome()!.hookModifiedFiles.length })}</strong> {t("results.hooksRest")}{" "}
          <span class="ui-mono">
            {outcome()!.hookModifiedFiles.slice(0, 3).join(", ")}
            {outcome()!.hookModifiedFiles.length > 3 ? ` ${t("results.more", { n: outcome()!.hookModifiedFiles.length - 3 })}` : ""}
          </span>
        </Notice>
      </Show>
      <Show when={outcome() && !outcome()!.reconciled && status() === "done"}>
        <Notice
          tone="warn"
          icon={TriangleAlert}
          action={
            <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => act("refresh")}>
              {t("comp.refresh")}
            </Button>
          }
        >
          <strong>{t("results.notReconciled")}</strong> {t("results.notReconciledRest")}
        </Notice>
      </Show>
      <Show when={localOnly()}>
        <Notice
          tone="info"
          icon={Info}
          action={
            <Button size="sm" variant="secondary" onClick={() => openPushDialog([row().repoId])}>
              {t("cmd.push")}
            </Button>
          }
        >
          <strong>{t("results.localOnly")}</strong>
          <Show when={committedNotPushed(row().repoId)}>
            {" "}
            <span class="ui-mono">{shortOid(committedNotPushed(row().repoId))}</span>
          </Show>
        </Notice>
      </Show>

      <Show when={actions().length || hasOutput()}>
        <div class="results-row__actions">
          <For each={actions()}>
            {(action) => (
              <Button
                size="sm"
                variant={action === "pullThenPush" ? "primary" : "secondary"}
                icon={action === "retry" || action === "pullThenPush" ? RefreshCw : undefined}
                onClick={() => act(action)}
                title={action === "pullThenPush" ? t("results.act.pullThenPushTip") : undefined}
              >
                {{ retry: t("comp.retry"), pullThenPush: t("results.act.pullThenPush"), retryNoHooks: t("results.act.retryNoHooks"), refresh: t("comp.refresh") }[action]}
              </Button>
            )}
          </For>
          <Show when={hasOutput()}>
            <Button size="sm" variant="ghost" class="results-row__toggle" iconRight={open() ? ChevronUp : ChevronDown} aria-expanded={open()} onClick={() => setOpen(!open())}>
              {open() ? t("results.hideOutput") : t("results.showOutput")}
            </Button>
          </Show>
        </div>
      </Show>
      <Show when={open() && hasOutput()}>
        <Output row={row()} />
      </Show>
    </li>
  );
}

/** Tells the toaster how tall the sheet is, so toasts stack above it instead of covering its buttons. */
function liftToasts(el: HTMLElement): void {
  const root = document.documentElement.style;
  const observer = new ResizeObserver(() => root.setProperty("--toast-lift", `${el.offsetHeight + 8}px`));
  observer.observe(el);
  onCleanup(() => {
    observer.disconnect();
    root.removeProperty("--toast-lift");
  });
}

/** Non-modal sheet with the outcome of the last commit/push, per repo. */
export function ResultsSheet() {
  const [collapsed, setCollapsed] = createSignal(false);
  const [confirm, setConfirm] = createSignal<SheetRow | null>(null);
  const visible = () => sheetOpen() && sheetRows().length > 0;
  const active = () => activeSheetRun();
  const title = () => (latestSheetRun()?.kind === "push" ? t("results.pushTitle") : t("results.commitTitle"));

  createEffect(on(() => sheetRows().length, (n, prev) => n > 0 && !prev && setCollapsed(false)));

  return (
    <>
      <Show when={visible()}>
        <section class="results-sheet" ref={liftToasts} aria-label={title()} data-collapsed={collapsed() ? "" : undefined}>
          <header class="results-sheet__head">
            <div class="results-sheet__titles">
              <h3 class="results-sheet__title">{title()}</h3>
              <p class="results-sheet__summary" aria-live="off">
                {sheetSummary()}
              </p>
            </div>
            <Show when={active()}>
              {(run) => (
                <Button size="sm" variant="secondary" loading={run().cancelling} onClick={() => void cancelRun(run().runId)}>
                  {t("comp.cancel")}
                </Button>
              )}
            </Show>
            <IconButton icon={collapsed() ? ChevronUp : ChevronDown} size="sm" label={collapsed() ? t("results.expand") : t("results.collapse")} onClick={() => setCollapsed(!collapsed())} />
            <IconButton icon={X} size="sm" label={t("results.close")} onClick={closeSheet} />
          </header>
          <Show when={!collapsed()}>
            <ScrollArea class="results-sheet__scroll">
              <ul class="results-sheet__list">
                <For each={sheetRows()}>{(row) => <ResultRow row={row} onRetryWithoutHooks={setConfirm} />}</For>
              </ul>
            </ScrollArea>
          </Show>
        </section>
      </Show>
      <Dialog
        open={confirm() !== null}
        onClose={() => setConfirm(null)}
        role="alertdialog"
        size="sm"
        title={t("results.retryTitle")}
        description={t("results.retryDesc")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)} data-autofocus>
              {t("comp.cancel")}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                const row = confirm();
                setConfirm(null);
                if (row) void retryRow(row, { noVerify: true });
              }}
            >
              {confirm()?.kind === "push" ? t("results.pushNoHooks") : t("results.commitNoHooks")}
            </Button>
          </>
        }
      >
        <Show when={confirm()}>
          {(row) => (
            <p class="results-confirm">
              {tRich("results.noVerify", { flag: <span class="ui-mono">--no-verify</span>, name: <strong>{repoName(row().repoId)}</strong> })}
            </p>
          )}
        </Show>
      </Dialog>
    </>
  );
}
