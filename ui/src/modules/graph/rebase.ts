import { t } from "../../i18n";
import type { RebaseAction, RebaseStep } from "../../ipc/graph";

export type { RebaseAction, RebaseStep };

/** The action picker options; a function so the labels follow the language. */
export const rebaseActions = (): { value: RebaseAction; label: string }[] => [
  { value: "pick", label: t("graph.rebase.pick") },
  { value: "reword", label: t("graph.rebase.rewordAction") },
  { value: "squash", label: t("graph.rebase.squash") },
  { value: "fixup", label: t("graph.rebase.fixup") },
  { value: "drop", label: t("graph.rebase.drop") },
];

/** A new array with the step at `from` moved to index `to`. */
export function moveStep<T>(steps: readonly T[], from: number, to: number): T[] {
  const next = steps.slice();
  if (from < 0 || from >= next.length) return next;
  const target = Math.min(Math.max(to, 0), next.length - 1);
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

/** Sets the action of one step; a message only makes sense for reword and squash, so other actions drop it. */
export function setAction(steps: readonly RebaseStep[], index: number, action: RebaseAction): RebaseStep[] {
  return steps.map((s, i) => {
    if (i !== index) return s;
    const { message: _message, ...rest } = s;
    return action === "reword" ? { ...rest, action, message: s.message?.trim() ? s.message : s.subject } : { ...rest, action, message: action === "squash" ? s.message : undefined };
  });
}

export const setMessage = (steps: readonly RebaseStep[], index: number, message: string): RebaseStep[] => steps.map((s, i) => (i === index ? { ...s, message } : s));

export interface PreviewCommit {
  subject: string;
  /** Commits folded into this one, oldest first. */
  from: string[];
  reworded: boolean;
}

/** What the branch will look like after the plan, oldest first. `problems` lists reasons the plan cannot run. */
export function previewRebase(steps: readonly RebaseStep[]): { commits: PreviewCommit[]; problems: string[] } {
  const commits: PreviewCommit[] = [];
  const problems: string[] = [];
  for (const [i, step] of steps.entries()) {
    if (step.action === "drop") continue;
    if (step.action === "squash" || step.action === "fixup") {
      const last = commits[commits.length - 1];
      if (!last) problems.push(t("graph.rebase.noBase", { n: i + 1, action: step.action }));
      else last.from.push(step.oid);
      continue;
    }
    if (step.action === "reword" && !step.message?.trim()) problems.push(t("graph.rebase.needsMessage", { n: i + 1 }));
    commits.push({ subject: step.action === "reword" ? (step.message?.split("\n", 1)[0] ?? step.subject) : step.subject, from: [step.oid], reworded: step.action === "reword" });
  }
  if (steps.length > 0 && commits.length === 0 && !problems.length) problems.push(t("graph.rebase.allDropped"));
  return { commits, problems };
}

export const planChanged = (original: readonly RebaseStep[], steps: readonly RebaseStep[]): boolean =>
  original.length !== steps.length || original.some((s, i) => s.oid !== steps[i].oid || s.action !== steps[i].action || (s.message ?? "") !== (steps[i].message ?? ""));
