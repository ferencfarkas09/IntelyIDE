import { t } from "../../i18n";
import { openTab } from "../../platform/tabs";
import { shortOid } from "./format";

/** Tab openers live apart from the lazy tab components, so the module's `register()` imports none of them. */
const fileName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

export const openMatrix = (): string => openTab({ type: "matrix", id: "matrix", title: t("graph.tab.branches") });

export const openHunks = (repoId: string, path: string): string => openTab({ type: "hunks", id: `hunks:${repoId}:${path}`, title: t("graph.tab.hunksOf", { name: fileName(path) }), params: { repoId, path } });

export const openHistory = (repoId: string, path: string): string => openTab({ type: "filehistory", id: `filehistory:${repoId}:${path}`, title: t("graph.tab.historyOf", { name: fileName(path) }), params: { repoId, path } });

/** Opens (or focuses) the diff of one file of a commit as a centre tab. */
export function openCommitFile(repoId: string, oid: string, file: { path: string; origPath?: string }): void {
  openTab({ type: "commitdiff", id: `commitdiff:${repoId}:${oid}:${file.path}`, title: `${fileName(file.path)} @ ${shortOid(oid)}`, params: { repoId, oid, path: file.path, origPath: file.origPath } });
}
