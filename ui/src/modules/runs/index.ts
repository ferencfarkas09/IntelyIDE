import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerInspectorPanel } from "../../platform/inspector";
import { registerModeView, setAppMode } from "../../platform/mode";
import { registerOverlay } from "../../platform/overlay";
import { agentRow, agentRows, interruptRun, needsYouCount, selectAgent, selectedAgentId } from "../../store/agents";
import { Bot } from "../../ui-kit";
import { nextNeedsYou } from "./sessionsLogic";
import { setCentreView, setNewRunOpen } from "./state";

const activeRun = () => {
  const row = agentRow(selectedAgentId());
  return row && (row.status === "running" || row.status === "needsYou") ? row : undefined;
};

export function register(): void {
  registerModeView({ id: "agent", get title() { return t("runs.mode.agent"); }, icon: Bot, component: lazy(() => import("./AgentWorkspace")) });
  registerOverlay({ id: "runs", component: lazy(() => import("./RunsRoot")) });
  registerInspectorPanel({ id: "run", get title() { return t("runs.panel.run"); }, order: 10, component: lazy(() => import("./RunSummaryPanel")) });

  registerCommand({ id: "runs.new", get title() { return t("runs.cmd.new"); }, get group() { return t("group.agents"); }, keywords: ["start", "run", "agent", "prompt"], shortcut: "Mod+Shift+N", run: () => void setNewRunOpen(true) });
  registerCommand({
    id: "runs.stop",
    get title() { return t("runs.cmd.stop"); },
    get group() { return t("group.agents"); },
    keywords: ["interrupt", "cancel", "agent"],
    when: () => !!activeRun(),
    run: async () => {
      const row = activeRun();
      if (row) await interruptRun(row.agentId);
    },
  });
  registerCommand({
    id: "runs.nextNeedsYou",
    get title() { return t("runs.cmd.next"); },
    get group() { return t("group.agents"); },
    keywords: ["permission", "question", "waiting", "inbox"],
    shortcut: "Mod+Shift+J",
    when: () => needsYouCount() > 0,
    run: async () => {
      const id = nextNeedsYou(agentRows(), selectedAgentId());
      if (!id) return;
      setAppMode("agent");
      setCentreView("run");
      await selectAgent(id);
    },
  });
  registerCommand({
    id: "runs.inbox",
    get title() { return t("runs.cmd.inbox"); },
    get group() { return t("group.agents"); },
    keywords: ["permission", "question", "requests"],
    run: () => {
      setAppMode("agent");
      setCentreView("inbox");
    },
  });
}
