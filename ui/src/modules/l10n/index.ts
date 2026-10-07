// Localization checker (Wave 3 X1, backlog #3): which languages still miss the i18n keys the working tree adds,
// a matrix tab, a badge in the Changes tree, and "Translate missing" with a per-key review. A lazy extra with a
// Settings toggle: while it is off only the Settings section exists, nothing is loaded, watched or drawn.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerChangeBadge } from "../../platform/changeBadges";
import { registerOverlay } from "../../platform/overlay";
import { registerSettingsSection } from "../../platform/settings";
import { openTab, registerTabType } from "../../platform/tabs";
import { Globe } from "../../ui-kit";
import { l10nEnabled } from "./toggle";

let live: (() => void)[] = [];

function activate(): void {
  if (live.length) return;
  live = [
    registerTabType({ type: "l10n", get title() { return t("l10n.name"); }, icon: Globe, component: lazy(() => import("./L10nTab")), canClose: true }),
    registerChangeBadge({ id: "l10n", component: lazy(() => import("./ChangeBadge")) }),
    registerOverlay({ id: "l10n.watcher", component: lazy(() => import("./Watcher")) }),
    registerCommand({ id: "l10n.open", get title() { return t("l10n.cmd.open"); }, get group() { return t("l10n.name"); }, keywords: ["translate", "i18n", "locale", "missing", "language"], run: () => void openTab({ type: "l10n", id: "l10n", title: t("l10n.name") }) }),
    registerCommand({ id: "l10n.translate", get title() { return t("l10n.cmd.translate"); }, get group() { return t("l10n.name"); }, keywords: ["haiku", "draft", "translation"], run: () => void openTab({ type: "l10n", id: "l10n", title: t("l10n.name") }) }),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "l10n", get title() { return t("l10n.name"); }, order: 92, icon: Globe, searchTerms: ["i18n", "translate", "locale", "language", "missing keys"], component: lazy(() => import("./L10nSection")) });
  createRoot(() => createEffect(() => (l10nEnabled() ? activate() : deactivate())));
}

