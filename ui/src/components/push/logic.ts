import { t } from "../../i18n";
import type { OutgoingInfo, PushRequest, PushTarget, RepoSnapshot, TagsMode } from "../../ipc";

/** A repo can be selected for a push when it has something to push and can push at all. */
export function isPushable(plan: OutgoingInfo): boolean {
  return plan.canPush && plan.commits.length > 0;
}

/**
 * Initial checkbox state: repos with outgoing commits are ticked, the others stay unticked and greyed.
 * With `preselected` (a per-repo "Push" action) only those repos start ticked.
 */
export function defaultChecks(plans: readonly OutgoingInfo[], preselected?: readonly string[]): Record<string, boolean> {
  return Object.fromEntries(plans.map((p) => [p.repoId, isPushable(p) && p.checkedByDefault && (!preselected || preselected.includes(p.repoId))]));
}

/**
 * Whether "Commit and Push..." should show the dialog before pushing. Protected targets always preview;
 * other branches only while the "Preview commits before push" toggle is on.
 */
export function requiresPreview(plans: readonly OutgoingInfo[], previewNonProtected: boolean): boolean {
  return plans.some((p) => isPushable(p) && (p.protected || previewNonProtected));
}

export interface PushOptions {
  tags: TagsMode;
  /** Off sends `noVerify`. */
  runHooks: boolean;
}

export interface BuildPushInput extends PushOptions {
  runId: string;
  plans: readonly OutgoingInfo[];
  checks: Readonly<Record<string, boolean>>;
  /** Repos pushed with `--force-with-lease`. */
  force?: readonly string[];
  /** What the human typed per repo for a live branch (sent as `confirmLive`). */
  confirm?: Readonly<Record<string, string>>;
}

/**
 * The `seenOid` is empty on purpose: the UI does not know the remote tip. The engine resolves it from the
 * freshly fetched tracking ref (see the contract note on `ForceWithLease`).
 */
export function buildPushRequest(input: BuildPushInput): PushRequest {
  const targets: PushTarget[] = input.plans
    .filter((p) => input.checks[p.repoId] && isPushable(p))
    .map((p) => ({
      repoId: p.repoId,
      remote: p.remote,
      remoteBranch: p.remoteBranch,
      tags: input.tags,
      forceWithLease: input.force?.includes(p.repoId) ? { seenOid: "" } : undefined,
      ...(p.protected && input.confirm?.[p.repoId] ? { confirmLive: input.confirm[p.repoId] } : {}),
    }));
  return { runId: input.runId, targets, noVerify: !input.runHooks };
}

export interface LiveRow {
  repoId: string;
  repoName: string;
  /** The remote branch name that has to be typed. */
  branch: string;
}

/** Ticked repos whose target is a live branch (protected pattern, the repo's `liveBranches` or the remote HEAD). */
export function liveRows(plans: readonly OutgoingInfo[], checks: Readonly<Record<string, boolean>>, repoName: (id: string) => string): LiveRow[] {
  return plans
    .filter((p) => checks[p.repoId] && isPushable(p) && p.protected)
    .map((p) => ({ repoId: p.repoId, repoName: repoName(p.repoId), branch: p.remoteBranch }));
}

/** Push stays disabled until every live branch name is typed exactly (no trimming: the engine compares exactly). */
export function liveConfirmed(rows: readonly LiveRow[], typed: Readonly<Record<string, string>>): boolean {
  return rows.every((r) => typed[r.repoId] === r.branch);
}

export interface ForceRow {
  repoId: string;
  repoName: string;
  /** `remote/branch`. */
  target: string;
  /** The remote branch name that has to be typed for protected branches. */
  branch: string;
  protected: boolean;
  /** Remote commits missing locally (they would be overwritten); null when it cannot be told from the snapshot. */
  overwritten: number | null;
}

/** Rows of the force-push confirmation for the ticked repos. */
export function forceRows(
  plans: readonly OutgoingInfo[],
  checks: Readonly<Record<string, boolean>>,
  repoName: (id: string) => string,
  snapshots: Readonly<Record<string, RepoSnapshot | undefined>>,
): ForceRow[] {
  return plans
    .filter((p) => checks[p.repoId] && isPushable(p))
    .map((p) => {
      const upstream = snapshots[p.repoId]?.upstream;
      const sameBranch = upstream && upstream.remote === p.remote && upstream.branch === p.remoteBranch;
      return {
        repoId: p.repoId,
        repoName: repoName(p.repoId),
        target: `${p.remote}/${p.remoteBranch}`,
        branch: p.remoteBranch,
        protected: p.protected,
        overwritten: p.remoteOnly ?? (sameBranch ? (snapshots[p.repoId]?.behind ?? null) : null),
      };
    });
}

/** Protected branches need their name typed exactly; everything else only the explicit confirm click. */
export function canConfirmForce(rows: readonly ForceRow[], typed: Readonly<Record<string, string>>): boolean {
  return rows.length > 0 && rows.every((r) => !r.protected || typed[r.repoId] === r.branch);
}

/** `ahead` summary for a repo row, e.g. "2 commits" or "New branch". */
export function outgoingLabel(plan: OutgoingInfo): string {
  if (!plan.canPush) return plan.blockedReason ?? t("push.cannot");
  const n = plan.commits.length;
  if (n === 0) return plan.newRemoteBranch ? t("push.newBranch") : t("push.nothing");
  return t(plan.newRemoteBranch ? "push.outgoingNew" : "push.outgoing", { n });
}

/** Compact relative time for the commit list: "just now", "5 min ago", "3 h ago", "2 d ago". */
export function timeAgo(dateMs: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - dateMs) / 60_000));
  if (minutes < 1) return t("chat.ago.now");
  if (minutes < 60) return t("chat.ago.min", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("chat.ago.hour", { n: hours });
  return t("push.ago.day", { n: Math.floor(hours / 24) });
}

/** Splits `a/b/c.ts` into the directory hint (`a/b`) and the file name. */
export function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i < 0 ? { dir: "", name: path } : { dir: path.slice(0, i), name: path.slice(i + 1) };
}
