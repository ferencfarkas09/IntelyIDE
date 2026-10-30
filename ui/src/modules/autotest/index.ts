// Auto-test after a run: when a run finishes, the unit tests of the repositories it touched run (as a Run panel process,
// with CI=1) and their result shows on the run card and at the top of the run's page, with "Ask the agent to fix the
// failing tests". Off / ask once per repository / always, in Settings. A lazy extra that starts switched on.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerRunSlot } from "../../platform/runSlots";
import { registerSettingsSection } from "../../platform/settings";
import { agentRow, selectedAgentId } from "../../store/agents";
import { ListChecks, toast } from "../../ui-kit";
import AutotestChip from "./AutotestChip";
import AutotestHeaderButton from "./AutotestHeaderButton";
import { canRunTests } from "./flow";
import { autotestFlow, currentRuns, watchRuns } from "./instance";
import { loadPrefs } from "./store";
import { autotestEnabled } from "./toggle";

let live: (() => void)[] = [];

/** "Run tests for this run" of the palette: the selected run's repositories, unless a run on them is still live. */
function runSelected(): void {
  const row = agentRow(selectedAgentId());
  if (!row) return;
  if (!canRunTests(currentRuns(), row.agentId, row.repoIds)) {
    toast.info(t("autotest.header.busyTip"));
    return;
  }
  void autotestFlow().runTests(row.agentId, row.repoIds);
}

function activate(): void {
  if (live.length) return;
  void loadPrefs();
  live = [
    registerRunSlot({ id: "autotest.chip", place: "card", order: 40, component: AutotestChip }),
    registerRunSlot({ id: "autotest.top", place: "top", order: 40, component: lazy(() => import("./AutotestTop")) }),
    registerRunSlot({ id: "autotest.header", place: "header", order: 40, component: AutotestHeaderButton }),
    registerCommand({
      id: "autotest.run",
      get title() {
        return t("autotest.cmd.run");
      },
      get group() {
        return t("autotest.name");
      },
      keywords: ["test", "tests", "unit", "vitest", "jest", "pytest", "cargo test", "check"],
      when: () => !!agentRow(selectedAgentId())?.repoIds.length,
      run: runSelected,
    }),
    watchRuns(),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "autotest", get title() { return t("autotest.section.name"); }, order: 105, icon: ListChecks, searchTerms: ["test", "tests", "unit tests", "vitest", "jest", "pytest", "cargo test", "after a run"], component: lazy(() => import("./AutotestSection")) });
  createRoot(() => createEffect(() => (autotestEnabled() ? activate() : deactivate())));
}
