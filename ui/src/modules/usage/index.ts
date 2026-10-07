// The Usage view: what the plan has left (session and week) and what the runs of this IDE have used, by day, hour and model.
// A tab, a command and a Settings entry; nothing is read until the tab is opened.
import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerSettingsSection } from "../../platform/settings";
import { registerTabType } from "../../platform/tabs";
import { ChartColumn } from "../../ui-kit";
import { openUsage } from "./open";

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
    order: 99,
    icon: ChartColumn,
    searchTerms: ["usage", "tokens", "cost", "limit", "weekly", "session", "consumption"],
    component: lazy(() => import("./UsageSection")),
  });
}
