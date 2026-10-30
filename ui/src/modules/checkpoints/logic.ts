import { t, type MessageKey } from "../../i18n";
import type { RewindFile } from "../../ipc/runs";
import type { RepoPlan, RunCheckpoint, StepKind } from "./types";

const KIND_KEY = {
  start: "checkpoints.kind.start",
  turn: "checkpoints.kind.turn",
  end: "checkpoints.kind.end",
  save: "checkpoints.kind.save",
  restore: "checkpoints.kind.restore",
} as const satisfies Record<StepKind, MessageKey>;

/** What a step is, in the person's words: its label when it has one, else what made it. */
export function stepTitle(step: RunCheckpoint): string {
  return step.label?.trim() || t(KIND_KEY[step.kind] ?? "checkpoints.kind.turn");
}

export const kindText = (kind: StepKind): string => t(KIND_KEY[kind] ?? "checkpoints.kind.turn");

/**
 * Where "Undo last step" goes: the step before the newest one that changed something. Steps that changed nothing (a save point
 * on an unchanged tree, a restore that found nothing to do) are walked past. Undefined when nothing was changed yet.
 */
export function undoTarget(steps: readonly RunCheckpoint[]): RunCheckpoint | undefined {
  const sorted = [...steps].sort((a, b) => a.seq - b.seq);
  for (let i = sorted.length - 1; i > 0; i--) {
    if (sorted[i].changed > 0) return sorted[i - 1];
  }
  return undefined;
}

/** Steps newest first, for the timeline. */
export const newestFirst = (steps: readonly RunCheckpoint[]): RunCheckpoint[] => [...steps].sort((a, b) => b.seq - a.seq);

/** The step just before `seq` (the base of its Compare), if any. */
export function previousStep(steps: readonly RunCheckpoint[], seq: number): RunCheckpoint | undefined {
  return [...steps].filter((s) => s.seq < seq).sort((a, b) => b.seq - a.seq)[0];
}

/** The files a restore would touch, as the Rewind dialog lists them (`created` = deleted again, `deleted` = brought back). */
export function planFiles(plans: readonly RepoPlan[]): RewindFile[] {
  return plans.flatMap((p) => [
    ...p.overwrite.map((path) => ({ repoId: p.repoId, path, change: "modified" as const })),
    ...p.recreate.map((path) => ({ repoId: p.repoId, path, change: "deleted" as const })),
    ...p.delete.map((path) => ({ repoId: p.repoId, path, change: "created" as const })),
  ]);
}

export const conflictCount = (plans: readonly RepoPlan[]): number => plans.reduce((n, p) => n + p.conflicts.length, 0);

/** How many files a restore writes: all of them, or all but the conflicts when the person keeps their later edits. */
export function touchedCount(plans: readonly RepoPlan[], overwriteConflicts: boolean): number {
  const all = planFiles(plans).length;
  return overwriteConflicts ? all : all - conflictCount(plans);
}

/**
 * What the person types to confirm: the repository's name for a one-repository run (the Rewind rule: no trim, case counts), a fixed
 * word for a run on several repositories.
 */
export function restorePhrase(repoNames: readonly string[]): string {
  return repoNames.length === 1 ? repoNames[0] : t("checkpoints.restore.phraseMany");
}

export interface Gate {
  ok: boolean;
  reason?: string;
}

export function restoreGate(s: { runActive: boolean; files: number | undefined; typed: string; phrase: string; busy: boolean }): Gate {
  if (s.runActive) return { ok: false, reason: t("checkpoints.gate.active") };
  if (s.files === undefined) return { ok: false, reason: t("checkpoints.gate.listing") };
  if (s.files === 0) return { ok: false, reason: t("checkpoints.gate.nothing") };
  if (s.typed !== s.phrase) return { ok: false, reason: t("checkpoints.gate.type", { phrase: s.phrase }) };
  return s.busy ? { ok: false, reason: t("checkpoints.gate.busy") } : { ok: true };
}

/** Error text in the person's words for the codes the host answers with. */
export function errorText(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  if (code === "repoBusy") return t("checkpoints.error.repoBusy");
  if (code === "agentRunning") return t("checkpoints.error.running");
  if (code === "noCheckpoint") return t("checkpoints.error.none");
  return e instanceof Error ? e.message : String((e as { message?: string } | null)?.message ?? e);
}

/** A label typed for a save point: one line, at most 80 characters (the host cleans it the same way). */
export function cleanLabel(raw: string): string {
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}
