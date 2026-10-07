import { batch, createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { amend, markInvalid, messageMode, messagesSent, repoMessage, repoMessages, setAmend, setRepoMessage, setSharedMessage, SHARED_FIELD, sharedMessage } from "../components/commit/messageState";
import { answerExecSurfaceConfirm, confirmExecSurface, execSurfaceConfirmRequest, findExecSurface } from "../components/commit/execSurface";
import { commitLabel, describeProblem, planCommit, sensitiveFiles, type CommitPlan, type CommitProblem } from "../components/commit/logic";
import { runCommitGuards } from "../platform/commitSlots";
import { buildPushRequest, defaultChecks, requiresPreview } from "../components/push/logic";
import { previewNonProtected, pushTags, runGitHooks } from "../components/push/settings";
import { applyEvent, applyResult, newRun, summarizeStatuses, type RepoRunState, type RunState } from "../components/results/logic";
import {
  ipc,
  type CommitRequest,
  type EngineError,
  type OpEvent,
  type OpResult,
  type PullMode,
  type PushRequest,
  type PushTarget,
  type RepoCommit,
  type RepoId,
  type RepoOutcome,
  type RunStarted,
} from "../ipc";
import { rowKey } from "../components/changes/flatten";
import { requestScroll, setRepoExpanded } from "../components/changes/treeState";
import { announce, toast } from "../ui-kit";
import { t, type MessageKey } from "../i18n";
import { partialHunks } from "./partialSelection";
import { checkedFiles } from "./selection";
import { snapshots } from "./snapshots";
import { workspace } from "./workspace";

const [results, setResults] = createSignal<OpResult | null>(null);

/** Result of the last commit/push run, shown in the results sheet. */
export const lastResults = results;

// ---- run tracking -----------------------------------------------------------------------------------------------

const [runs, setRuns] = createStore<Record<string, RunState>>({});
const waiters = new Map<string, (r: OpResult) => void>();
/** Events that arrive before the run is registered (pull and fetch learn their run id from the command reply). */
const orphans = new Map<string, { events: OpEvent[]; result?: OpResult }>();

export const getRun = (runId: string): RunState | undefined => runs[runId];

const KEEP_FINISHED_RUNS = 12;

/** Drops the oldest finished runs that no sheet row shows, so streamed output cannot pile up over a long session. */
function pruneRuns(): void {
  const shown = new Set(sheet.rows.map((r) => r.runId));
  const old = Object.values(runs)
    .filter((r) => r.finishedAtMs !== undefined && !shown.has(r.runId))
    .sort((a, b) => b.startedAtMs - a.startedAtMs)
    .slice(KEEP_FINISHED_RUNS);
  if (old.length) setRuns(produce((all) => old.forEach((r) => delete all[r.runId])));
}

function finishRun(r: OpResult): void {
  setRuns(r.runId, produce((run) => applyResult(run, r)));
  if (r.kind === "commit" || r.kind === "push") setResults(r);
  waiters.get(r.runId)?.(r);
  waiters.delete(r.runId);
  pruneRuns();
}

function onEvent(e: OpEvent): void {
  if (runs[e.runId]) return setRuns(e.runId, produce((run) => applyEvent(run, e)));
  const o = orphans.get(e.runId) ?? { events: [] };
  o.events.push(e);
  orphans.set(e.runId, o);
}

function onResult(r: OpResult): void {
  if (runs[r.runId]) return finishRun(r);
  const o = orphans.get(r.runId) ?? { events: [] };
  o.result = r;
  orphans.set(r.runId, o);
}

// Subscribed at import time: the Tauri listeners register asynchronously, so they must exist before the first run.
ipc.onOpEvent(onEvent);
ipc.onOpResult(onResult);

function register(run: RunState): Promise<OpResult> {
  setRuns(run.runId, run);
  const done = new Promise<OpResult>((resolve) => waiters.set(run.runId, resolve));
  const pending = orphans.get(run.runId);
  if (pending) {
    orphans.delete(run.runId);
    pending.events.forEach(onEvent);
    if (pending.result) finishRun(pending.result);
  }
  return done;
}

const asEngineError = (e: unknown): EngineError =>
  typeof e === "object" && e !== null && typeof (e as EngineError).code === "string" ? (e as EngineError) : { code: "io", message: String(e) };

/** The command itself was rejected (nothing ran): turn that into a failed result for every repo of the run. */
function rejectRun(run: RunState, e: unknown): void {
  const error = asEngineError(e);
  const kind = error.code === "lockBusy" ? "lockBusy" : error.code === "guardBlocked" ? "guardBlocked" : error.code === "invalidSelection" ? "invalidSelection" : "unknown";
  const repos: RepoOutcome[] = run.repoIds.map((repoId) => ({
    repoId,
    status: "failed",
    reconciled: true,
    hookModifiedFiles: [],
    failure: { kind, message: error.message, output: error.detail ?? undefined },
  }));
  finishRun({ runId: run.runId, kind: run.kind, repos, finishedAtMs: Date.now() });
}

export async function cancelRun(runId: string): Promise<void> {
  const run = runs[runId];
  if (!run || run.finishedAtMs !== undefined || run.cancelling) return;
  setRuns(runId, "cancelling", true);
  try {
    if (run.kind === "commit") await ipc.commitCancel(runId);
    else if (run.kind === "push") await ipc.pushCancel(runId);
  } catch {
    setRuns(runId, "cancelling", false);
  }
}

// ---- results sheet ---------------------------------------------------------------------------------------------

/** One repo line of the sheet. Live state is looked up in the run; the request is kept for retries. */
export interface SheetRow {
  repoId: RepoId;
  runId: string;
  kind: "commit" | "push";
  /** Created by "Commit and Push...", so a missing push leaves the commit local. */
  thenPush: boolean;
  commit?: RepoCommit;
  target?: PushTarget;
  noVerify: boolean;
}

const [sheet, setSheet] = createStore<{ open: boolean; rows: SheetRow[] }>({ open: false, rows: [] });
const [committed, setCommitted] = createSignal<Record<RepoId, string>>({});

export const sheetOpen = (): boolean => sheet.open;
export const sheetRows = (): readonly SheetRow[] => sheet.rows;
export const closeSheet = (): void => setSheet("open", false);
export const openSheet = (): void => setSheet("open", true);
export const rowState = (row: SheetRow): RepoRunState | undefined => runs[row.runId]?.repos[row.repoId];
/** Oid of a commit made in this session that has not been pushed since. */
export const committedNotPushed = (repoId: RepoId): string | undefined => committed()[repoId];
/** The most recently started run among the sheet's rows; it names the sheet and feeds the header summary. */
export const latestSheetRun = (): RunState | undefined =>
  sheet.rows
    .map((r) => runs[r.runId])
    .filter((r): r is RunState => !!r)
    .reduce<RunState | undefined>((latest, r) => (!latest || r.startedAtMs >= latest.startedAtMs ? r : latest), undefined);
/** Header summary of the sheet, for the title area. */
export const sheetSummary = (): string =>
  sheet.rows.length ? summarizeStatuses(sheet.rows.map((r) => r.kind), sheet.rows.map((r) => rowState(r)?.status ?? "queued")) : "";
/** Rows of the last run that still need the user: failed or cancelled, or committed here without a push. Feeds the status bar when the sheet is closed. */
export const sheetAttention = (): number =>
  sheet.rows.filter((row) => {
    const status = rowState(row)?.status;
    return status === "failed" || status === "cancelled" || (status === "done" && row.kind === "commit" && row.thenPush && !!committed()[row.repoId]);
  }).length;
/** A run of the sheet that is still going; the sheet offers Cancel for it. */
export const activeSheetRun = (): RunState | undefined => {
  for (const row of sheet.rows) {
    const run = runs[row.runId];
    if (run && run.finishedAtMs === undefined) return run;
  }
  return undefined;
};

/** `fresh` replaces the sheet; rows of other repos for which `keepWhenFresh` holds survive (failures that still need attention). */
function upsertRows(fresh: boolean, rows: SheetRow[], keepWhenFresh?: (row: SheetRow) => boolean): void {
  const ids = new Set(rows.map((r) => r.repoId));
  const keep = sheet.rows.filter((r) => !ids.has(r.repoId) && (!fresh || keepWhenFresh?.(r)));
  const order = new Map(sheet.rows.map((r, i) => [r.repoId, i]));
  const merged = [...keep, ...rows].sort((a, b) => (order.get(a.repoId) ?? 99) - (order.get(b.repoId) ?? 99));
  batch(() => setSheet({ open: true, rows: merged }));
}

// ---- helpers ---------------------------------------------------------------------------------------------------

export const repoName = (repoId: RepoId): string => workspace()?.repos.find((r) => r.id === repoId)?.name ?? repoId;

const orderedRepoIds = (): RepoId[] => {
  const ws = workspace();
  if (ws) return [...ws.repos].sort((a, b) => a.order - b.order).map((r) => r.id);
  return Object.keys(snapshots());
};

const newRunId = (): string => crypto.randomUUID();

function currentCommitPlan(repoIds: readonly RepoId[]): CommitPlan {
  return planCommit({
    runId: newRunId(),
    repoIds,
    snapshots: snapshots(),
    checkedFiles,
    partial: partialHunks,
    mode: messageMode(),
    sharedMessage: sharedMessage(),
    repoMessages: repoMessages(),
    amend: amend(),
  });
}

const PROBLEM_TITLES = {
  noFiles: "store.problem.noFiles",
  emptyMessage: "store.problem.emptyMessage",
  amendMultiple: "store.problem.amendMultiple",
  amendInProgress: "store.problem.amendInProgress",
  conflicts: "results.fail.conflict",
} as const satisfies Record<CommitProblem["kind"], MessageKey>;

/** Moves focus to the first empty message field; a per-repo field may sit in a collapsed or not yet rendered row. */
function focusInvalidMessage(problem: CommitProblem | undefined): void {
  if (problem?.kind !== "emptyMessage") return;
  const repoId = problem.repoId;
  if (repoId) {
    setRepoExpanded(repoId, true);
    requestScroll(rowKey(repoId, "message"));
  }
  const selector = repoId ? `.repo-message[data-repo-id="${CSS.escape(repoId)}"] textarea` : "textarea[data-commit-message]";
  let tries = 0;
  const attempt = () => {
    const field = document.querySelector<HTMLTextAreaElement>(selector);
    if (field) field.focus({ preventScroll: !repoId });
    else if (++tries < 10) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

/** Reports a rejected plan: marks the empty message fields and tells the user why nothing happened. */
function reportProblems(plan: CommitPlan): void {
  const first = plan.problems[0];
  if (!first) return;
  markInvalid(plan.problems.filter((p) => p.kind === "emptyMessage").map((p) => (p.kind === "emptyMessage" ? (p.repoId ?? SHARED_FIELD) : "")));
  focusInvalidMessage(plan.problems.find((p) => p.kind === "emptyMessage"));
  const text = describeProblem(first, repoName);
  // The toast is a live region itself.
  toast.warn(t(PROBLEM_TITLES[first.kind]), text);
}

/** Preview of the button label and counts for the current selection (all repos). */
export function commitPreview(): { repos: number; files: number; label: string; conflicts: RepoId[] } {
  const plan = currentCommitPlan(orderedRepoIds());
  const conflicts = plan.problems.flatMap((p) => (p.kind === "conflicts" ? [p.repoId] : []));
  return { repos: plan.repos, files: plan.files, label: commitLabel(plan.repos, plan.files, amend()), conflicts };
}

// ---- commit ----------------------------------------------------------------------------------------------------

interface CommitOptions {
  thenPush: boolean;
  /** Replace the sheet instead of updating the retried repos' rows. */
  fresh: boolean;
}

async function runCommit(request: CommitRequest, opts: CommitOptions): Promise<OpResult> {
  const run = newRun(request.runId, "commit", request.repos.map((r) => r.repoId));
  const done = register(run);
  upsertRows(
    opts.fresh,
    request.repos.map((rc) => ({ repoId: rc.repoId, runId: request.runId, kind: "commit", thenPush: opts.thenPush, commit: rc, noVerify: request.noVerify })),
  );
  try {
    await ipc.commitStart(request);
  } catch (e) {
    rejectRun(run, e);
  }
  const result = await done;
  afterCommit(request, result);
  return result;
}

function afterCommit(request: CommitRequest, result: OpResult): void {
  const doneIds = result.repos.filter((o) => o.status === "done").map((o) => o.repoId);
  const sent = request.repos.filter((rc) => doneIds.includes(rc.repoId));
  batch(() => {
    messagesSent(sent, messageMode(), sent.length === request.repos.length);
    setCommitted((c) => ({ ...c, ...Object.fromEntries(result.repos.filter((o) => o.status === "done" && o.commitOid).map((o) => [o.repoId, o.commitOid!])) }));
  });
  const failed = result.repos.filter((o) => o.status === "failed").length;
  const text = t("store.committedCount", { done: doneIds.length, total: result.repos.length });
  // The results sheet already says this; a toast is only needed when the user closed it (and then it announces itself).
  if (!sheet.open) {
    if (failed) toast.error(t("results.commitFailed"), text);
    else if (doneIds.length) toast.success(t("results.committed"), text);
  } else announce(failed ? t("store.withFailed", { text, failed }) : text, failed ? "assertive" : "polite");
}

/** Files waiting for the extra confirmation before they are committed; `resolve` carries the answer back to the commit. */
const [sensitiveAsk, setSensitiveAsk] = createSignal<{ files: { repoId: RepoId; path: string }[]; resolve: (ok: boolean) => void } | null>(null);
export const sensitiveConfirmRequest = sensitiveAsk;
export function answerSensitiveConfirm(ok: boolean): void {
  const ask = sensitiveAsk();
  setSensitiveAsk(null);
  ask?.resolve(ok);
}

let guarding = false;

async function startCommit(repoIds: readonly RepoId[], thenPush: boolean): Promise<void> {
  if (activeSheetRun()?.kind === "commit" || sensitiveAsk() || execSurfaceConfirmRequest() || guarding) return;
  const plan = currentCommitPlan(repoIds);
  if (!plan.request) return reportProblems(plan);
  markInvalid([]);
  const sensitive = sensitiveFiles(plan.request, snapshots());
  if (sensitive.length && !(await new Promise<boolean>((resolve) => setSensitiveAsk({ files: sensitive, resolve })))) return;
  if (thenPush) {
    // Files that run code (hooks, lint-staged, package.json scripts ...) are shown once more before they are pushed; the human can continue.
    const execFiles = await findExecSurface(plan.request.repos.map((r) => ({ repoId: r.repoId, paths: r.files.map((f) => f.path) })));
    if (execFiles.length && !(await confirmExecSurface(execFiles))) return;
  }
  // Modules may ask one more question first (a secret-looking value in the diff); a "no" ends the commit here.
  guarding = true;
  const proceed = await runCommitGuards({ repos: plan.request.repos.map((r) => ({ repoId: r.repoId, paths: r.files.map((f) => f.path) })) }).finally(() => (guarding = false));
  if (!proceed) return;
  const result = await runCommit(plan.request, { thenPush, fresh: true });
  if (thenPush) {
    const ids = result.repos.filter((o) => o.status === "done").map((o) => o.repoId);
    if (ids.length) await pushAfterCommit(ids);
  }
}

/** Commits the ticked files of every repo. */
export async function commitAll(): Promise<void> {
  await startCommit(orderedRepoIds(), false);
}

/** Commits, then pushes: through the dialog when it must preview, directly otherwise. */
export async function commitAndPush(): Promise<void> {
  await startCommit(orderedRepoIds(), true);
}

export async function commitRepo(repoId: RepoId): Promise<void> {
  await startCommit([repoId], false);
}

// ---- push ------------------------------------------------------------------------------------------------------

const [dialog, setDialog] = createSignal<{ preselected?: readonly RepoId[] } | null>(null);

/** Non-null while the push dialog is open; `preselected` lists the repos that start ticked. */
export const pushDialogRequest = dialog;
export const closePushDialog = (): void => void setDialog(null);

/** Opens the push dialog; without ids, for all repos. */
export function openPushDialog(repoIds?: RepoId[]): void {
  setDialog({ preselected: repoIds });
}

export async function pushRepo(repoId: RepoId): Promise<void> {
  openPushDialog([repoId]);
}

/** Starts a push and tracks it. Progress is in `getRun(request.runId)`; resolves with the final result. */
export async function runPush(request: PushRequest, opts: { thenPush?: boolean; fresh?: boolean } = {}): Promise<OpResult> {
  const run = newRun(request.runId, "push", request.targets.map((t) => t.repoId));
  const done = register(run);
  upsertRows(
    opts.fresh ?? false,
    request.targets.map((t) => ({ repoId: t.repoId, runId: request.runId, kind: "push", thenPush: opts.thenPush ?? false, target: t, noVerify: request.noVerify })),
    // A repo whose commit failed is not part of the push that follows "Commit and Push…"; its failure and Retry must stay.
    (row) => runs[row.runId]?.repos[row.repoId]?.status === "failed",
  );
  try {
    await ipc.pushStart(request);
  } catch (e) {
    rejectRun(run, e);
  }
  const result = await done;
  afterPush(result);
  return result;
}

function afterPush(result: OpResult): void {
  const ok = result.repos.filter((o) => o.status === "done");
  setCommitted((c) => Object.fromEntries(Object.entries(c).filter(([id]) => !ok.some((o) => o.repoId === id))));
  const failed = result.repos.filter((o) => o.status === "failed").length;
  const text = t("store.pushedCount", { ok: ok.length, total: result.repos.length });
  if (!sheet.open) {
    if (failed) toast.error(t("results.pushFailed"), text);
    else if (ok.length) toast.success(t("results.pushed"), text);
  } else announce(failed ? t("store.withFailed", { text, failed }) : text, failed ? "assertive" : "polite");
}

async function pushAfterCommit(repoIds: readonly RepoId[]): Promise<void> {
  try {
    const plans = await ipc.pushPlan([...repoIds], false);
    if (!requiresPreview(plans, previewNonProtected())) {
      const request = buildPushRequest({
        runId: newRunId(),
        plans,
        checks: defaultChecks(plans, repoIds),
        tags: pushTags(),
        runHooks: runGitHooks(),
      });
      if (request.targets.length) {
        await runPush(request, { thenPush: true });
        return;
      }
    }
  } catch {
    // The dialog shows the planning error and lets the user retry.
  }
  openPushDialog([...repoIds]);
}

// ---- pull and fetch --------------------------------------------------------------------------------------------

async function runSimple(kind: "pull" | "fetch", repoId: RepoId, start: () => Promise<RunStarted>): Promise<OpResult | null> {
  let started: RunStarted;
  try {
    started = await start();
  } catch (e) {
    toast.error(t(kind === "pull" ? "store.pullFailed" : "store.fetchFailed"), `${repoName(repoId)}: ${asEngineError(e).message}`);
    return null;
  }
  const done = register(newRun(started.runId, kind, [repoId]));
  const result = await done;
  const outcome = result.repos[0];
  if (outcome?.status === "done") toast.success(t(kind === "pull" ? "store.pullDone" : "store.fetchDone"), repoName(repoId));
  else toast.error(t(kind === "pull" ? "store.pullFailed" : "store.fetchFailed"), `${repoName(repoId)}: ${outcome?.failure?.message ?? t("store.seeOutput")}`);
  return result;
}

export async function pullRepo(repoId: RepoId, mode: PullMode = "ffOnly"): Promise<void> {
  await runSimple("pull", repoId, () => ipc.pull(repoId, mode));
}

export async function fetchRepo(repoId: RepoId): Promise<void> {
  await runSimple("fetch", repoId, () => ipc.fetch(repoId));
}

// ---- row actions of the results sheet --------------------------------------------------------------------------

/** Runs a failed commit or push of one repo again; `noVerify` skips the hooks (the sheet asks for confirmation first). */
export async function retryRow(row: SheetRow, opts: { noVerify?: boolean } = {}): Promise<void> {
  const noVerify = opts.noVerify ?? row.noVerify;
  if (row.kind === "commit" && row.commit) {
    await runCommit({ runId: newRunId(), repos: [row.commit], noVerify }, { thenPush: row.thenPush, fresh: false }).then((result) => {
      if (row.thenPush && result.repos.some((o) => o.status === "done")) return pushAfterCommit([row.repoId]);
    });
  } else if (row.kind === "push" && row.target) {
    await runPush({ runId: newRunId(), targets: [row.target], noVerify }, { thenPush: row.thenPush });
  }
}

/** For a non-fast-forward push: merges the remote branch into the local one, then pushes the same target again. */
export async function pullThenPush(row: SheetRow): Promise<void> {
  const target = row.target;
  if (!target) return;
  const result = await runSimple("pull", row.repoId, () => ipc.pull(row.repoId, "merge"));
  if (result?.repos[0]?.status === "done") await runPush({ runId: newRunId(), targets: [target], noVerify: row.noVerify }, { thenPush: row.thenPush });
}

/** Asks the engine for a fresh snapshot of a repo (after a commit whose index could not be reconciled). */
export async function refreshRepo(repoId: RepoId): Promise<void> {
  await ipc.snapshotRefresh(repoId);
}

// ---- amend -----------------------------------------------------------------------------------------------------

/** Texts that were filled in from the last commit, so unticking Amend only clears what the user did not write. */
const prefilled = new Map<string, string>();

async function prefill(field: string, repoId: RepoId, current: string, set: (text: string) => void): Promise<void> {
  // An earlier prefill that the user has not touched is replaced (the amend target may have changed repo).
  if (current.trim() && prefilled.get(field) !== current) return;
  try {
    const text = await ipc.commitMessageLast(repoId);
    if (!text.trim()) return;
    prefilled.set(field, text);
    set(text);
  } catch {
    // The last message is a convenience; the field simply stays empty.
  }
}

/** Toggles Amend and prefills empty message fields with the HEAD message of the repo they belong to. */
export async function setAmendMode(on: boolean): Promise<void> {
  setAmend(on);
  if (!on) {
    const ids = orderedRepoIds();
    const clear = (field: string, current: string, set: (text: string) => void) => {
      if (prefilled.get(field) === current) set("");
      prefilled.delete(field);
    };
    clear(SHARED_FIELD, sharedMessage(), setSharedMessage);
    for (const id of ids) clear(id, repoMessage(id), (text) => setRepoMessage(id, text));
    return;
  }
  await refreshAmendPrefill();
}

/** Prefills (or re-prefills) the message fields of the repos that would be amended; user-written text is kept. */
export async function refreshAmendPrefill(): Promise<void> {
  if (!amend()) return;
  const ids = orderedRepoIds();
  const withFiles = ids.filter((id) => checkedFiles(id).length > 0);
  if (messageMode() === "shared") {
    const first = withFiles[0] ?? ids[0];
    if (first) await prefill(SHARED_FIELD, first, sharedMessage(), setSharedMessage);
  } else {
    await Promise.all(withFiles.map((id) => prefill(id, id, repoMessage(id), (text) => setRepoMessage(id, text))));
  }
}

/** Test hook: forget runs, rows, and pending dialog state. */
export function resetActions(): void {
  waiters.clear();
  orphans.clear();
  batch(() => {
    setRuns(produce((all) => Object.keys(all).forEach((k) => delete all[k])));
    setSheet({ open: false, rows: [] });
    setCommitted({});
    setResults(null);
    setDialog(null);
  });
  answerSensitiveConfirm(false);
  answerExecSurfaceConfirm(false);
}
