import { t } from "../../../i18n";
import type { Ipc } from "../../../ipc";
import type { Inspection } from "../model";
import { hunksOf, revertHunks, type Decision, type Hunk } from "./hunks";

export interface ReviewFile {
  repoId: string;
  path: string;
  created: boolean;
  deleted: boolean;
  hunks: Hunk[];
}

/** The files of a run that can be reviewed: inside a known repo and with a recorded diff or a deletion. */
export function reviewFilesOf(i: Inspection): ReviewFile[] {
  return i.files.flatMap((f) => {
    if (!f.repoId) return [];
    // Hunk ids are unique across the whole review, so the decisions of two files never collide.
    const hunks = f.diffs.flatMap((d, k) => hunksOf(d.old, d.new, k)).map((h) => ({ ...h, id: `${f.repoId}\0${f.path}\0${h.id}` }));
    return hunks.length > 0 || f.deleted ? [{ repoId: f.repoId, path: f.path, created: f.created, deleted: f.deleted, hunks }] : [];
  });
}

export const decisionOf = (decisions: Readonly<Record<string, Decision>>, h: Hunk): Decision => decisions[h.id] ?? "keep";
export const revertedHunks = (f: ReviewFile, decisions: Readonly<Record<string, Decision>>): Hunk[] => f.hunks.filter((h) => decisionOf(decisions, h) === "revert");
export const revertCount = (files: readonly ReviewFile[], decisions: Readonly<Record<string, Decision>>): number => files.reduce((n, f) => n + revertedHunks(f, decisions).length, 0);

/** A created file is removed by Rewind, not by reverting its single add-everything hunk. */
export const canRevert = (f: ReviewFile): boolean => !f.created && !f.deleted;

export interface FileApply {
  repoId: string;
  path: string;
  status: "reverted" | "failed";
  message?: string;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String((e as { message?: string }).message ?? e));

/** Writes the reverted hunks back through the files namespace (which enforces the stale-file check and the jail). One file failing does not stop the others. */
export async function applyReverts(files: readonly ReviewFile[], decisions: Readonly<Record<string, Decision>>, client: Ipc): Promise<FileApply[]> {
  const out: FileApply[] = [];
  for (const f of files) {
    const hunks = revertedHunks(f, decisions);
    if (hunks.length === 0 || !canRevert(f)) continue;
    try {
      const cur = await client.files.readFile(f.repoId, f.path);
      if (cur.text === undefined) throw { message: t("inspector.review.notText") };
      const { text, failed } = revertHunks(cur.text, hunks);
      if (failed.length > 0) {
        out.push({ repoId: f.repoId, path: f.path, status: "failed", message: t("inspector.review.staleHunks", { n: failed.length }) });
        continue;
      }
      await client.files.writeFile(f.repoId, f.path, text, cur.mtimeMs);
      out.push({ repoId: f.repoId, path: f.path, status: "reverted" });
    } catch (e) {
      out.push({ repoId: f.repoId, path: f.path, status: "failed", message: (e as { code?: string })?.code === "staleFile" ? t("inspector.review.staleFile") : message(e) });
    }
  }
  return out;
}
