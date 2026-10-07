// PR bridge (Wave 4 GitX, backlog #17): the pull requests of the current branch and of the user with their CI and review
// state, and a human-initiated Create PR (a draft by default) on the GitHub CLI. A lazy extra with a Settings toggle:
// while it is off only the Settings section exists and no code of the tab is loaded.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerSettingsSection } from "../../platform/settings";
import { openTab, registerTabType } from "../../platform/tabs";
import { GitPullRequestArrow } from "../../ui-kit";
import { setCreateRequests } from "./store";
import { prEnabled } from "./toggle";

let live: (() => void)[] = [];

function openPr(create = false): void {
  void openTab({ type: "pr", id: "pr", title: t("pr.name") });
  if (create) setCreateRequests((n) => n + 1);
}

function activate(): void {
  if (live.length) return;
  live = [
    registerTabType({ type: "pr", get title() { return t("pr.name"); }, icon: GitPullRequestArrow, component: lazy(() => import("./PrTab")), canClose: true }),
    registerCommand({ id: "pr.open", get title() { return t("pr.cmd.open"); }, get group() { return t("pr.cmd.group"); }, keywords: ["pull request", "github", "gh", "ci", "checks", "review"], run: () => openPr() }),
    registerCommand({ id: "pr.create", get title() { return t("pr.cmd.create"); }, get group() { return t("pr.cmd.group"); }, keywords: ["pull request", "draft", "github", "gh"], run: () => openPr(true) }),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "pr", get title() { return t("pr.name"); }, order: 95, icon: GitPullRequestArrow, searchTerms: ["pull request", "github", "gh", "ci", "checks", "draft"], component: lazy(() => import("./PrSection")) });
  createRoot(() => createEffect(() => (prEnabled() ? activate() : deactivate())));
}
