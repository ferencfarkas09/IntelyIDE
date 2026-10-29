// Dashboard and widgets: a tab of cards (Run Pulse, Burn-down, Repo Heartbeat, Stack tips, Dev servers, CI & PRs, Sentry triage,
// Team chat, Morning brief) built only from what other features already know, the widget registry other modules can add cards to
// (`platform/widgets.ts`), the plan usage in the menu bar (opt-in) and the Needs-You radar window. A lazy extra that starts switched
// on, with a Settings toggle: while it is off only the Settings section exists and no card code is loaded.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { appMode, setAppMode } from "../../platform/mode";
import type { Disposer } from "../../platform/registry";
import { registerSettingsSection } from "../../platform/settings";
import { activateTab, activeTab, closeTab, registerTabType, tabs } from "../../platform/tabs";
import { selectAgent } from "../../store/agents";
import { repos, workspaceState } from "../../store/workspace";
import { activeId } from "../../store/workspaces";
import { LayoutGrid } from "../../ui-kit";
import { setCentreView } from "../runs/state";
import { registerBuiltinWidgets } from "./builtin";
import { DASHBOARD_TAB_ID, openDashboard } from "./open";
import { startPlanPoll } from "./planPoll";
import { radarApi } from "./radar/api";
import { dashboardAtStart, dashboardEnabled } from "./toggle";

let live: Disposer[] = [];

/** "Open" in the radar window: the main window comes forward (Rust) and shows that run in Agent mode. */
function openRunFromRadar(agentId: string): void {
  setAppMode("agent");
  setCentreView("run");
  void selectAgent(agentId);
}

function activate(): void {
  if (live.length) return;
  live = [
    registerTabType({ type: "dashboard", get title() { return t("dash.name"); }, icon: LayoutGrid, component: lazy(() => import("./Dashboard")), canClose: true }),
    registerCommand({ id: "dashboard.open", get title() { return t("dash.cmd.open"); }, group: "View", keywords: ["dashboard", "home", "overview", "widgets", "cards", "start", "welcome"], run: () => void openDashboard() }),
    registerCommand({ id: "dashboard.radar", get title() { return t("dash.cmd.radar"); }, get group() { return t("group.agents"); }, keywords: ["needs you", "radar", "approve", "permission", "question", "window", "always on top"], run: () => void radarApi().open().catch(() => {}) }),
    ...registerBuiltinWidgets(),
    radarApi().onOpenRun(openRunFromRadar),
    startPlanPoll(),
  ];
}

function deactivate(): void {
  closeTab(DASHBOARD_TAB_ID, { force: true });
  for (const off of live) off();
  live = [];
}

/**
 * The dashboard is the first tab of a workspace: once per page (a workspace switch reloads it), after the saved tabs are back, when
 * the workspace has repositories and Agent mode is not on screen. A restored editor tab keeps the focus; the dashboard opens beside it.
 */
function openAtStart(): void {
  let done = false;
  createRoot(() =>
    createEffect(() => {
      if (done || workspaceState() !== "ready" || !activeId()) return;
      done = true;
      if (!dashboardEnabled() || !dashboardAtStart() || appMode() === "agent" || repos().length === 0) return;
      // after the workspace's saved tabs were restored (the same "ready" tick)
      setTimeout(() => {
        if (!dashboardEnabled() || tabs().some((tab) => tab.id === DASHBOARD_TAB_ID)) return;
        // The built-in Diff tab is always there and empty at start: only a restored editor tab keeps the focus.
        const before = activeTab();
        openDashboard();
        if (before && before.type !== "diff") activateTab(before.id);
      }, 0);
    }),
  );
}

export function register(): void {
  registerSettingsSection({ id: "dashboard", get title() { return t("dash.section.name"); }, order: 105, icon: LayoutGrid, searchTerms: ["dashboard", "widgets", "cards", "start", "menu bar", "tray", "plan", "radar"], component: lazy(() => import("./DashboardSection")) });
  createRoot(() => createEffect(() => (dashboardEnabled() ? activate() : deactivate())));
  openAtStart();
}

