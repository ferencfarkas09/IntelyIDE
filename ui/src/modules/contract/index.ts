// API contract (Wave 4, backlog #10 and #11): contract-drift detector between the backend swagger and the client
// repos, plus a read-only swagger explorer. A lazy extra with a Settings toggle: while it is off only the Settings
// section exists, nothing is loaded, scanned or drawn.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerChangeBadge } from "../../platform/changeBadges";
import { registerOverlay } from "../../platform/overlay";
import { registerSettingsSection } from "../../platform/settings";
import { openTab, registerTabType } from "../../platform/tabs";
import { Plug } from "../../ui-kit";
import { contractEnabled } from "./toggle";

let live: (() => void)[] = [];

const open = (view: "findings" | "explorer") => void openTab({ type: "contract", id: "contract", title: t("contract.name"), params: { view } });

function activate(): void {
  if (live.length) return;
  live = [
    registerTabType({ type: "contract", get title() { return t("contract.name"); }, icon: Plug, component: lazy(() => import("./ContractTab")), canClose: true }),
    registerChangeBadge({ id: "contract", component: lazy(() => import("./ChangeBadge")) }),
    registerOverlay({ id: "contract.watcher", component: lazy(() => import("./Watcher")) }),
    registerCommand({ id: "contract.open", get title() { return t("contract.cmd.open"); }, get group() { return t("contract.name"); }, keywords: ["api", "swagger", "openapi", "drift", "endpoint"], run: () => open("findings") }),
    registerCommand({ id: "contract.explorer", get title() { return t("contract.cmd.explorer"); }, get group() { return t("contract.name"); }, keywords: ["api", "swagger", "curl", "schema", "explorer"], run: () => open("explorer") }),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "contract", get title() { return t("contract.name"); }, order: 96, icon: Plug, searchTerms: ["api", "swagger", "openapi", "contract", "drift", "endpoints"], component: lazy(() => import("./ContractSection")) });
  createRoot(() => createEffect(() => (contractEnabled() ? activate() : deactivate())));
}
