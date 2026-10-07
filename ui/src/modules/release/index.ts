// Changelog and release assistant (Wave 3 X1, backlog #7): commits since the last release become a changelog entry in
// the repo's own multi-language shape plus a version bump proposal, shown as a diff. A lazy extra with a Settings toggle.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerSettingsSection } from "../../platform/settings";
import { openTab, registerTabType } from "../../platform/tabs";
import { Tag } from "../../ui-kit";
import { releaseEnabled } from "./toggle";

let live: (() => void)[] = [];

function activate(): void {
  if (live.length) return;
  live = [
    registerTabType({ type: "release", get title() { return t("release.name"); }, icon: Tag, component: lazy(() => import("./ReleaseTab")), canClose: true }),
    registerCommand({ id: "release.open", get title() { return t("release.cmd.open"); }, get group() { return t("release.name"); }, keywords: ["changelog", "version", "whats new", "tag", "bump"], run: () => void openTab({ type: "release", id: "release", title: t("release.name") }) }),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "release", get title() { return t("release.section.name"); }, order: 91, icon: Tag, searchTerms: ["changelog", "version", "bump", "whats new", "tag"], component: lazy(() => import("./ReleaseSection")) });
  createRoot(() => createEffect(() => (releaseEnabled() ? activate() : deactivate())));
}
