import { t, type MessageKey } from "../../../i18n";
import type { RewindFile } from "../../../ipc/runs";

/** What the user types to confirm: the repo name, exactly (no trim, case counts), so the target is read, not clicked through. */
export const confirmPhrase = (repoName: string): string => repoName;

const CHANGE_KEY = { modified: "inspector.rewind.change.modified", created: "inspector.rewind.change.created", deleted: "inspector.rewind.change.deleted" } as const satisfies Record<RewindFile["change"], MessageKey>;
/** What a rewind does to a file, in the current language. */
export const changeText = (change: RewindFile["change"]): string => t(CHANGE_KEY[change]);

export interface RestoreGate {
  ok: boolean;
  /** Why the button is off, shown as its tooltip. */
  reason?: string;
}

export function restoreGate(s: { runActive: boolean; snapshotId: string | undefined; fileCount: number | undefined; typed: string; phrase: string; busy: boolean }): RestoreGate {
  if (s.runActive) return { ok: false, reason: t("inspector.rewind.gateActive") };
  if (!s.snapshotId) return { ok: false, reason: t("inspector.rewind.gatePick") };
  if (s.fileCount === undefined) return { ok: false, reason: t("inspector.rewind.gateListing") };
  if (s.fileCount === 0) return { ok: false, reason: t("inspector.rewind.gateNothing") };
  if (s.typed !== s.phrase) return { ok: false, reason: t("inspector.rewind.gateType", { phrase: s.phrase }) };
  return s.busy ? { ok: false, reason: t("inspector.rewind.gateBusy") } : { ok: true };
}

/** Preview files grouped by repo, in the order the repos first appear. */
export function groupByRepo(files: readonly RewindFile[]): { repoId: string; files: RewindFile[] }[] {
  const groups = new Map<string, RewindFile[]>();
  for (const f of files) groups.set(f.repoId, [...(groups.get(f.repoId) ?? []), f]);
  return [...groups].map(([repoId, list]) => ({ repoId, files: list }));
}
