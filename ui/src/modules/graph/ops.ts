import { t } from "../../i18n";
import type { OpOutcome } from "../../ipc/graph";

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : ((err as { message?: string } | null)?.message ?? t("graph.unknownError")));

/** The engine refuses history rewrites on live branches until the human types the branch name. */
export const needsLiveConfirm = (err: unknown): boolean => (err as { code?: string } | null)?.code === "liveBranchConfirm";

export const opLabel = (kind: OpOutcome["kind"]): string => (kind === "rebase" ? t("graph.op.rebase") : kind === "cherryPick" ? t("graph.op.cherryPick") : t("graph.op.operation"));

/** True while the operation waits for the user: conflicts to resolve, or stopped for another reason. */
export const opBlocked = (o: OpOutcome): boolean => o.status === "conflict" || o.status === "stopped";

/** One line for a banner or toast, e.g. "Rebase stopped at step 2 of 5: 3 conflicting files". */
export function describeOp(o: OpOutcome): string {
  const op = opLabel(o.kind);
  const head = o.total > 0 ? t("graph.op.stoppedAt", { op, step: o.step, total: o.total }) : t("graph.op.stopped", { op });
  if (o.status === "conflict") return t("graph.op.conflicts", { head, n: o.conflictFiles.length });
  if (o.status === "stopped") return o.message ? t("graph.op.reason", { head, message: o.message }) : head;
  return t("graph.op.finished", { op });
}
