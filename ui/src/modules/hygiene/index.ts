// Branch hygiene (Wave 3 X2, backlog #20) and the worktree manager (#21): merged and stale branches with a typed safe
// delete, tags, an ahead/behind matrix and the worktrees of a repo (only IDE-created ones can be removed). A lazy extra
// with a Settings toggle: while it is off only the Settings section exists.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerSettingsSection } from "../../platform/settings";
import { openTab, registerTabType } from "../../platform/tabs";
import { FolderGit2, GitBranch } from "../../ui-kit";
import { hygieneEnabled } from "./toggle";

let live: (() => void)[] = [];

function activate(): void {
  if (live.length) return;
  live = [
    registerTabType({ type: "hygiene", get title() { return t("hygiene.name"); }, icon: GitBranch, component: lazy(() => import("./HygieneTab")), canClose: true }),
    registerCommand({ id: "hygiene.open", get title() { return t("hygiene.cmd.open"); }, get group() { return t("hygiene.cmd.group"); }, keywords: ["hygiene", "prune", "delete", "merged", "stale", "tags", "worktree"], run: () => void openTab({ type: "hygiene", id: "hygiene", title: t("hygiene.name") }) }),
    registerCommand({ id: "hygiene.worktrees", get title() { return t("hygiene.cmd.worktrees"); }, get group() { return t("hygiene.cmd.group"); }, keywords: ["worktree", "cursor", "checkout"], run: () => void openTab({ type: "hygiene", id: "hygiene", title: t("hygiene.name") }) }),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "hygiene", get title() { return t("hygiene.name"); }, order: 93, icon: FolderGit2, searchTerms: ["branch", "stale", "merged", "worktree", "tag", "prune"], component: lazy(() => import("./HygieneSection")) });
  createRoot(() => createEffect(() => (hygieneEnabled() ? activate() : deactivate())));
}
