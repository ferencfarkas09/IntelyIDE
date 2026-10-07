import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerRailItem } from "../../platform/rail";
import { visibleTab } from "../../platform/mode";
import { registerTabType } from "../../platform/tabs";
import { agentRow, selectedAgentId } from "../../store/agents";
import { FileSearch, History, ListChecks } from "../../ui-kit";
import { openHistory, openInspector, openReview } from "./openers";
import type { RunParams } from "./useInspection";

/** The run the Agents panel has selected, as the params a run tab is opened with. */
function selectedRun(): RunParams | undefined {
  const id = selectedAgentId();
  const row = id ? agentRow(id) : undefined;
  return row ? { runId: row.agentId, title: row.title, role: row.role, repoIds: row.repoIds } : undefined;
}

export function register(): void {
  registerTabType({ type: "inspector", get title() { return t("inspector.tab.inspector"); }, icon: FileSearch, canClose: true, component: lazy(() => import("./Inspector")) });
  registerTabType({ type: "history", get title() { return t("inspector.tab.history"); }, icon: History, canClose: true, component: lazy(() => import("./history/History")) });
  registerTabType({ type: "review", get title() { return t("inspector.tab.reviewType"); }, icon: ListChecks, canClose: true, component: lazy(() => import("./review/ReviewTab")) });

  registerRailItem({ id: "history", icon: History, get title() { return t("inspector.rail.history"); }, order: 60, position: "left", run: openHistory, pressed: () => visibleTab()?.type === "history" });

  registerCommand({ id: "inspector.open", get title() { return t("inspector.cmd.open"); }, get group() { return t("group.agents"); }, keywords: ["timeline", "tools", "tokens", "events"], when: () => !!selectedRun(), run: () => void openInspector(selectedRun()!) });
  registerCommand({ id: "inspector.review", get title() { return t("inspector.cmd.review"); }, get group() { return t("group.agents"); }, keywords: ["diff", "hunks", "revert", "reviewer"], when: () => !!selectedRun(), run: () => void openReview(selectedRun()!) });
  registerCommand({ id: "inspector.rewind", get title() { return t("inspector.cmd.rewind"); }, get group() { return t("group.agents"); }, keywords: ["undo", "restore", "snapshot"], when: () => !!selectedRun(), run: () => void openInspector({ ...selectedRun()!, rewind: true }) });
  registerCommand({ id: "inspector.history", get title() { return t("inspector.cmd.history"); }, get group() { return t("group.agents"); }, keywords: ["sessions", "resume", "fork", "search"], run: () => void openHistory() });
}
