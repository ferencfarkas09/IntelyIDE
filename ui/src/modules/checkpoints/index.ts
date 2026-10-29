// Checkpoints (docs/checkpoints.md): a step of the run's timeline before each follow-up prompt and after each turn, named save
// points, Undo last step and Restore to any step through a dry run and a typed confirmation, a read-only Compare of two steps, and
// the opt-in protection of ignored config files. The host takes the checkpoints; this module shows and drives them.
// A lazy extra that starts switched on, with a Settings toggle.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerInspectorPanel } from "../../platform/inspector";
import { appMode, showTabInAgent } from "../../platform/mode";
import { registerOverlay } from "../../platform/overlay";
import { registerRunSlot } from "../../platform/runSlots";
import { registerSettingsSection } from "../../platform/settings";
import { openTab, registerTabType } from "../../platform/tabs";
import { agentRow, selectedAgentId } from "../../store/agents";
import { isForeign } from "../../store/agentScope";
import { History } from "../../ui-kit";
import { openSavePoint } from "./store";
import { checkpointsEnabled } from "./toggle";

let live: (() => void)[] = [];

/** The selected run, when checkpoints apply to it (a local run of this workspace). */
function selectedRun() {
  const row = agentRow(selectedAgentId());
  return row && !isForeign(row.repoIds) && !row.location && row.repoIds.length > 0 ? row : undefined;
}
const idle = () => {
  const row = selectedRun();
  return row && row.status !== "running" && row.status !== "needsYou" ? row : undefined;
};

export function openTimeline(runId: string, title?: string): string {
  const id = openTab({ type: "checkpoints", id: `checkpoints:${runId}`, title: t("checkpoints.tab", { title: title && title.length > 28 ? `${title.slice(0, 27)}…` : (title ?? runId) }), params: { runId } });
  if (appMode() === "agent") showTabInAgent(id);
  return id;
}

function activate(): void {
  if (live.length) return;
  live = [
    registerTabType({ type: "checkpoints", get title() { return t("checkpoints.name"); }, icon: History, component: lazy(() => import("./TimelineTab")), canClose: true }),
    registerInspectorPanel({ id: "checkpoints", get title() { return t("checkpoints.name"); }, order: 25, component: lazy(() => import("./TimelinePanel")) }),
    registerRunSlot({ id: "checkpoints.header", place: "header", order: 10, component: lazy(() => import("./HeaderButtons")) }),
    registerOverlay({ id: "checkpoints", component: lazy(() => import("./Dialogs")) }),
    registerCommand({ id: "checkpoints.save", get title() { return t("checkpoints.cmd.save"); }, get group() { return t("group.agents"); }, keywords: ["checkpoint", "save point", "bookmark", "snapshot"], when: () => !!selectedRun(), run: () => openSavePoint(selectedRun()!.agentId) }),
    registerCommand({ id: "checkpoints.undo", get title() { return t("checkpoints.cmd.undo"); }, get group() { return t("group.agents"); }, keywords: ["undo", "checkpoint", "restore", "step", "revert"], when: () => !!idle(), run: async () => void (await import("./HeaderButtons")).startUndo(idle()!.agentId) }),
    registerCommand({ id: "checkpoints.open", get title() { return t("checkpoints.cmd.open"); }, get group() { return t("group.agents"); }, keywords: ["checkpoint", "timeline", "compare", "restore", "history"], when: () => !!selectedRun(), run: () => void openTimeline(selectedRun()!.agentId, selectedRun()!.title) }),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "checkpoints", get title() { return t("checkpoints.section.name"); }, order: 110, icon: History, searchTerms: ["checkpoint", "save point", "undo", "restore", ".env", "config"], component: lazy(() => import("./CheckpointsSection")) });
  createRoot(() => createEffect(() => (checkpointsEnabled() ? activate() : deactivate())));
}
