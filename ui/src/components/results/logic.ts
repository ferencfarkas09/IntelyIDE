import type { FailureKind, OpEvent, OpKind, OpLine, OpResult, RepoOutcome, StepStatus } from "../../ipc";
import type { Tone } from "../../ui-kit";
import { t } from "../../i18n";
import { lazyLabels } from "../lazyLabels";

/** Streamed output kept per repo; older lines are dropped so a chatty hook cannot grow memory without bound. */
export const MAX_OUTPUT_LINES = 500;

export interface RepoRunState {
  status: StepStatus;
  percent?: number;
  lines: OpLine[];
  outcome?: RepoOutcome;
}

export interface RunState {
  runId: string;
  kind: OpKind;
  repoIds: string[];
  startedAtMs: number;
  repos: Record<string, RepoRunState>;
  finishedAtMs?: number;
  cancelling: boolean;
}

export function newRun(runId: string, kind: OpKind, repoIds: readonly string[], now = Date.now()): RunState {
  return {
    runId,
    kind,
    repoIds: [...repoIds],
    startedAtMs: now,
    cancelling: false,
    repos: Object.fromEntries(repoIds.map((id) => [id, { status: "queued" as StepStatus, lines: [] }])),
  };
}

const TERMINAL: ReadonlySet<StepStatus> = new Set(["done", "skipped", "failed", "cancelled"]);
export const isTerminal = (status: StepStatus): boolean => TERMINAL.has(status);

/** Folds an `op:event` into the run (mutates; call it on a store draft or a plain object). */
export function applyEvent(run: RunState, e: OpEvent): void {
  const repo = (run.repos[e.repoId] ??= { status: "queued", lines: [] });
  if (!isTerminal(repo.status) || isTerminal(e.status)) repo.status = e.status;
  if (e.percent != null) repo.percent = e.percent;
  if (e.line) {
    repo.lines.push(e.line);
    if (repo.lines.length > MAX_OUTPUT_LINES) repo.lines.splice(0, repo.lines.length - MAX_OUTPUT_LINES);
  }
}

/** Folds the final `op:result` into the run. Statuses from the outcome are authoritative. */
export function applyResult(run: RunState, r: OpResult): void {
  run.finishedAtMs = r.finishedAtMs;
  for (const outcome of r.repos) {
    const repo = (run.repos[outcome.repoId] ??= { status: outcome.status, lines: [] });
    repo.status = outcome.status;
    repo.outcome = outcome;
    repo.percent = undefined;
    // A failure's captured output is shown when nothing was streamed (for example a rejected push).
    if (!repo.lines.length && outcome.failure?.output) {
      repo.lines = outcome.failure.output.split(/\r?\n/).map((text) => ({ stream: "stderr" as const, text }));
    }
  }
  for (const id of run.repoIds) {
    const repo = run.repos[id];
    if (repo && !isTerminal(repo.status)) repo.status = "cancelled";
  }
}

export const STATUS_LABEL = lazyLabels<StepStatus>({
  queued: "results.status.queued",
  preparing: "results.status.preparing",
  hooks: "results.status.hooks",
  committing: "results.status.committing",
  reconciling: "results.status.reconciling",
  pushing: "results.status.pushing",
  done: "results.status.done",
  skipped: "results.status.skipped",
  failed: "results.status.failed",
  cancelled: "results.status.cancelled",
});

export function statusTone(status: StepStatus): Tone {
  switch (status) {
    case "done": return "ok";
    case "failed": return "danger";
    case "cancelled": return "warn";
    case "queued":
    case "skipped": return "neutral";
    default: return "accent";
  }
}

export type RowAction = "retry" | "pullThenPush" | "retryNoHooks" | "refresh";

export interface FailureView {
  title: string;
  hint?: string;
  actions: RowAction[];
}

/** Human wording and the recovery actions offered for each failure kind. */
export function describeFailure(kind: FailureKind, run: OpKind): FailureView {
  const retry: RowAction[] = ["retry"];
  switch (kind) {
    case "hookRejected":
      return {
        title: run === "push" ? t("results.fail.hookPush") : t("results.fail.hookCommit"),
        hint: t("results.fail.hookHint"),
        actions: ["retry", "retryNoHooks"],
      };
    case "nonFastForward":
      return { title: t("results.fail.nff"), hint: t("results.fail.nffHint"), actions: ["pullThenPush", "retry"] };
    case "lockBusy":
      return { title: t("results.fail.lock"), hint: t("results.fail.lockHint"), actions: retry };
    case "headMoved":
      return { title: t("results.fail.headMoved"), hint: t("results.fail.headMovedHint"), actions: retry };
    case "auth":
      return { title: t("results.fail.auth"), hint: t("results.fail.authHint"), actions: retry };
    case "network":
      return { title: t("results.fail.network"), hint: t("results.fail.networkHint"), actions: retry };
    case "remoteDeclined":
      return { title: t("results.fail.declined"), hint: t("results.fail.declinedHint"), actions: retry };
    case "emptyMessage":
      return { title: t("results.fail.emptyMessage"), actions: [] };
    case "nothingToCommit":
      return { title: t("results.fail.nothing"), hint: t("results.fail.nothingHint"), actions: [] };
    case "conflict":
      return { title: t("results.fail.conflict"), hint: t("results.fail.conflictHint"), actions: [] };
    case "guardBlocked":
      return { title: t("results.fail.guard"), hint: t("results.fail.guardHint"), actions: [] };
    case "invalidSelection":
      return { title: t("results.fail.invalid"), hint: t("results.fail.invalidHint"), actions: retry };
    default:
      return { title: run === "push" ? t("results.pushFailed") : t("results.commitFailed"), actions: retry };
  }
}

/** One-line summary of a finished or running run, used by the sheet header and the live region. */
export function summarizeRun(run: RunState): string {
  return summarizeStatuses([run.kind], run.repoIds.map((id) => run.repos[id]?.status ?? "queued"));
}

/** Summary over the rows the sheet shows: after "Commit and Push" they can come from a commit and a push run. */
export function summarizeStatuses(kinds: readonly OpKind[], states: readonly StepStatus[]): string {
  const distinct = [...new Set(kinds)];
  const kind = distinct.length === 1 ? distinct[0]! : "both";
  const count = (s: StepStatus) => states.filter((x) => x === s).length;
  if (states.some((s) => !isTerminal(s))) return t("results.inProgress", { kind });
  const parts = [t("results.part.done", { n: count("done") })];
  if (count("failed")) parts.push(t("results.part.failed", { n: count("failed") }));
  if (count("cancelled")) parts.push(t("results.part.cancelled", { n: count("cancelled") }));
  if (count("skipped")) parts.push(t("results.part.skipped", { n: count("skipped") }));
  return t("results.finished", { kind, parts: parts.join(", ") });
}
