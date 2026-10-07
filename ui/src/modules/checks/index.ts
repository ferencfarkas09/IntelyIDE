// Pre-commit checks (Wave 3 X2, backlog #18) and env/secret awareness (#19): a Checks block in the Commit panel,
// a secret-in-diff confirmation in the commit flow and an Environment tab (names only). A lazy extra with a Settings
// toggle: while it is off only the Settings section exists, nothing is loaded, scanned or drawn.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerCommitGuard, registerCommitPanelSlot } from "../../platform/commitSlots";
import { registerOverlay } from "../../platform/overlay";
import { registerSettingsSection } from "../../platform/settings";
import { openTab, registerTabType } from "../../platform/tabs";
import { KeyRound, ListChecks } from "../../ui-kit";
import { beforeCommitGuard } from "./beforeCommit";
import { secretGuard } from "./secretGuard";
import { checksEnabled } from "./toggle";

let live: (() => void)[] = [];

function activate(): void {
  if (live.length) return;
  live = [
    registerCommitPanelSlot({ id: "checks", order: 40, component: lazy(() => import("./ChecksPanel")) }),
    // Secrets first (instant, may cancel), then the quick checks (warn only).
    registerCommitGuard({ id: "checks.secrets", check: secretGuard }),
    registerCommitGuard({ id: "checks.before", check: beforeCommitGuard }),
    registerOverlay({ id: "checks.secrets", component: lazy(() => import("./SecretDialog")) }),
    registerTabType({ type: "env", get title() { return t("checks.env.tab"); }, icon: KeyRound, component: lazy(() => import("./EnvTab")), canClose: true }),
    registerCommand({ id: "checks.env", get title() { return t("checks.cmd.env"); }, get group() { return t("checks.name"); }, keywords: ["env", "dotenv", "secret", "variables", "example"], run: () => void openTab({ type: "env", id: "env", title: t("checks.env.tab") }) }),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "checks", get title() { return t("checks.section.name"); }, order: 94, icon: ListChecks, searchTerms: ["lint", "jest", "pre-commit", "secret", "token", "env", "dotenv"], component: lazy(() => import("./ChecksSection")) });
  createRoot(() => createEffect(() => (checksEnabled() ? activate() : deactivate())));
}
