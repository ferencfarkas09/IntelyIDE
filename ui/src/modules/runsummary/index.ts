// Run summary ("What this run did"): a card at the top of a finished run's page and a chip on its run card, built from
// the run's event log and read-only git without a model (files by purpose, commands, what to check, risks). "Explain in
// plain words" only prefills a New Run with those facts. A lazy extra that starts switched on, with a Settings toggle:
// while it is off only the Settings section exists and nothing is fetched or drawn.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { setAppMode } from "../../platform/mode";
import { registerRunSlot } from "../../platform/runSlots";
import { registerSettingsSection } from "../../platform/settings";
import { agentRow, selectedAgentId } from "../../store/agents";
import { FileText } from "../../ui-kit";
import { setCentreView } from "../runs/state";
import { isFinished } from "./logic";
import { requestShow } from "./store";
import { runSummaryEnabled } from "./toggle";

let live: (() => void)[] = [];

const finishedSelected = () => {
  const row = agentRow(selectedAgentId());
  return row && isFinished(row.status) ? row : undefined;
};

function activate(): void {
  if (live.length) return;
  live = [
    registerRunSlot({ id: "runsummary.card", place: "top", order: 10, component: lazy(() => import("./RunSummaryCard")) }),
    registerRunSlot({ id: "runsummary.chip", place: "card", order: 10, component: lazy(() => import("./RunSummaryChip")) }),
    registerCommand({
      id: "runsummary.show",
      get title() { return t("runsummary.cmd.show"); },
      get group() { return t("group.agents"); },
      keywords: ["summary", "what changed", "what did it do", "risks", "explain", "files", "recap"],
      when: () => !!finishedSelected(),
      run: () => {
        const row = finishedSelected();
        if (!row) return;
        setAppMode("agent");
        setCentreView("run");
        requestShow(row.agentId);
      },
    }),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "runsummary", get title() { return t("runsummary.section.name"); }, order: 109, icon: FileText, searchTerms: ["summary", "run summary", "what changed", "risks", "explain"], component: lazy(() => import("./RunSummarySection")) });
  createRoot(() => createEffect(() => (runSummaryEnabled() ? activate() : deactivate())));
}
