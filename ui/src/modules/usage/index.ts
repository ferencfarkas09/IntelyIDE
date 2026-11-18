// The Usage view: what the plan has left (session and week) and what the runs of this IDE have used, by day, hour and model.
// A tab, a command and a Settings entry; the report is not read until the tab is opened. The bottom bar items ("Weekly" and
// the week of a model class such as "Fable", when the plan reports one) are a lazy extra with a switch in Settings > Usage,
// on by default: while on, the plan limits are read a moment after the start and every five minutes.
import { createEffect, createRoot, createSignal, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerSettingsSection } from "../../platform/settings";
import { registerStatusItem } from "../../platform/statusbar";
import { registerTabType } from "../../platform/tabs";
import { ChartColumn } from "../../ui-kit";
import { planBar, planBarVisible, startPlanBarReader } from "./bar";
import { openUsage } from "./open";

let live: (() => void)[] = [];

function activate(): void {
  if (live.length) return;
  // before the selection summary, after the "needs attention" item
  live = [registerStatusItem({ id: "usage.plan", align: "right", order: 12, component: lazy(() => import("./PlanBar")), when: planBarVisible }), startPlanBarReader()];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerTabType({ type: "usage", get title() { return t("usage.name"); }, icon: ChartColumn, component: lazy(() => import("./UsageTab")), canClose: true });
  registerCommand({
    id: "usage.open",
    get title() { return t("usage.cmd.open"); },
    get group() { return t("group.agents"); },
    keywords: ["usage", "tokens", "cost", "limit", "limits", "weekly", "session", "heatmap", "consumption", "spend"],
    run: () => void openUsage(),
  });
  registerSettingsSection({
    id: "usage",
    get title() { return t("usage.name"); },
    order: 100,
    icon: ChartColumn,
    searchTerms: ["usage", "tokens", "cost", "limit", "weekly", "session", "consumption", "bottom bar", "status bar", "fable"],
    component: lazy(() => import("./UsageSection")),
  });
  // The switch's mirror can be missing (a new webview store) while settings.json says off: nothing is read, and no item is
  // shown, until the durable value has been adopted.
  const [synced, setSynced] = createSignal(false);
  void planBar.sync().finally(() => setSynced(true));
  createRoot(() => createEffect(() => (synced() && planBar.on() ? activate() : deactivate())));
}
