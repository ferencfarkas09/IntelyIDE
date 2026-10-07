import { t } from "../../i18n";
import type { Change, CommitRequest, FileSelection, HunkSelection, MessageMode, RepoCommit, RepoSnapshot } from "../../ipc";

export const HISTORY_LIMIT = 30;
/** Conventional guidance for the subject line length; only a hint, never blocks. */
export const SUBJECT_SOFT_LIMIT = 72;

const CONVENTIONAL = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)\n]+\))?!?: \S/;

export function validateMessage(message: string): { ok: true } | { ok: false; reason: "empty" } {
  return message.trim() ? { ok: true } : { ok: false, reason: "empty" };
}

export function subjectOf(message: string): string {
  return message.split("\n", 1)[0] ?? "";
}

/** A non-blocking nudge: `null` while the message is empty or already follows Conventional Commits. */
export function conventionalHint(message: string): string | null {
  const subject = subjectOf(message).trim();
  if (!subject || CONVENTIONAL.test(subject)) return null;
  return "feat(scope): subject";
}

/** Adds `message` to the front of the history: trimmed, de-duplicated, capped at {@link HISTORY_LIMIT}. */
export function pushHistory(history: string[], message: string): string[] {
  const text = message.trim();
  if (!text) return history;
  return [text, ...history.filter((m) => m !== text)].slice(0, HISTORY_LIMIT);
}

/** Whole-file selections for ticked paths. Guarded files and collapsed directories can never be committed. */
export function buildFileSelections(changes: Change[], paths: readonly string[], partial?: (path: string) => HunkSelection[] | undefined): FileSelection[] {
  const byPath = new Map(changes.map((c) => [c.path, c]));
  const selections: FileSelection[] = [];
  for (const path of paths) {
    const change = byPath.get(path);
    if (change && ((change.guard !== "ok" && change.guard !== "sensitive") || change.dir)) continue;
    const hunks = partial?.(path);
    if (hunks) {
      selections.push({ mode: "partial", path, hunks });
      continue;
    }
    const origPath = change?.origPath ?? undefined;
    selections.push(origPath ? { mode: "whole", path, origPath } : { mode: "whole", path });
  }
  return selections;
}

export type CommitProblem =
  | { kind: "noFiles" }
  | { kind: "emptyMessage"; repoId?: string }
  | { kind: "amendMultiple" }
  | { kind: "amendInProgress"; repoId: string }
  | { kind: "conflicts"; repoId: string };

export interface CommitInputs {
  runId: string;
  /** Repos to consider, in display order. */
  repoIds: readonly string[];
  snapshots: Readonly<Record<string, RepoSnapshot | undefined>>;
  checkedFiles: (repoId: string) => readonly string[];
  /** Hunks chosen for a file instead of the whole file (see store/partialSelection). */
  partial?: (repoId: string, path: string) => HunkSelection[] | undefined;
  mode: MessageMode;
  sharedMessage: string;
  repoMessages: Readonly<Record<string, string | undefined>>;
  amend: boolean;
  noVerify?: boolean;
}

export interface CommitPlan {
  request: CommitRequest | null;
  problems: CommitProblem[];
  repos: number;
  files: number;
}

/** Builds the `CommitRequest` from the selection and messages; repos without ticked files are left out. */
export function planCommit(input: CommitInputs): CommitPlan {
  const repos: RepoCommit[] = [];
  const problems: CommitProblem[] = [];
  let files = 0;
  for (const repoId of input.repoIds) {
    const selections = buildFileSelections(input.snapshots[repoId]?.changes ?? [], input.checkedFiles(repoId), input.partial && ((path) => input.partial!(repoId, path)));
    if (!selections.length) continue;
    const snap = input.snapshots[repoId];
    if (snap && snap.state !== "normal" && snap.state !== "bisecting") {
      // A merge, rebase, cherry-pick or revert commits the whole index and cannot be amended or completed with conflicts.
      if (input.amend) problems.push({ kind: "amendInProgress", repoId });
      else if (snap.changes.some((c) => c.kind === "conflicted")) problems.push({ kind: "conflicts", repoId });
    }
    const message = input.mode === "shared" ? input.sharedMessage : (input.repoMessages[repoId] ?? "");
    if (input.mode === "perRepo" && !validateMessage(message).ok) problems.push({ kind: "emptyMessage", repoId });
    repos.push({ repoId, files: selections, message: message.trimEnd(), amend: input.amend });
    files += selections.length;
  }
  if (!repos.length) problems.push({ kind: "noFiles" });
  else if (input.amend && repos.length > 1) problems.push({ kind: "amendMultiple" });
  else if (input.mode === "shared" && !validateMessage(input.sharedMessage).ok) problems.push({ kind: "emptyMessage" });
  return { request: problems.length ? null : { runId: input.runId, repos, noVerify: input.noVerify ?? false }, problems, repos: repos.length, files };
}

/** Files in the request that are tracked but look like credentials (`.npmrc`): they need one more confirmation. */
export function sensitiveFiles(request: CommitRequest, snapshots: Readonly<Record<string, RepoSnapshot | undefined>>): { repoId: string; path: string }[] {
  const out: { repoId: string; path: string }[] = [];
  for (const rc of request.repos) {
    const byPath = new Map((snapshots[rc.repoId]?.changes ?? []).map((c) => [c.path, c]));
    for (const f of rc.files) if (byPath.get(f.path)?.guard === "sensitive") out.push({ repoId: rc.repoId, path: f.path });
  }
  return out;
}

/** The primary button label, e.g. `Commit (3 repos, 12 files)`. */
export function commitLabel(repos: number, files: number, amend = false): string {
  if (amend && repos === 1) return t("commit.label.amend", { files });
  return repos > 0 ? t("commit.label.many", { repos, files }) : t("commit.label.commit");
}

export function describeProblem(problem: CommitProblem, repoName?: (id: string) => string): string {
  if (problem.kind === "noFiles") return t("commit.problem.noFiles");
  if (problem.kind === "amendInProgress") return t("commit.problem.amendInProgress", { name: repoName?.(problem.repoId) ?? problem.repoId });
  if (problem.kind === "conflicts") return t("commit.problem.conflicts", { name: repoName?.(problem.repoId) ?? problem.repoId });
  if (problem.kind === "amendMultiple") return t("commit.amendError");
  return problem.repoId ? t("commit.problem.enterFor", { name: repoName?.(problem.repoId) ?? problem.repoId }) : t("commit.enterMsg");
}
