import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { openDockTab, registerDockTab } from "../../platform/dock";
import { registerSettingsSection } from "../../platform/settings";
import { registerStatusItem } from "../../platform/statusbar";
import { ntReady, tasksItemVisible } from "../../store/happyNt";
import { ListChecks } from "../../ui-kit";

/**
 * My tasks ((design notes: integrations-plan) E4): a dock tab with the tasks assigned to you, by status, and three row actions:
 * start the Time Tracer, copy a branch name, start an agent on the task. Everything heavy is a lazy chunk.
 */
export function register(): void {
  registerStatusItem({ id: "happy-tasks", align: "right", order: 8, component: lazy(() => import("./TasksItem")), when: tasksItemVisible });
  registerDockTab({ id: "tasks", get title() { return t("ht.name"); }, icon: ListChecks, component: lazy(() => import("./TasksTab")) });
  registerSettingsSection({
    id: "happy-tasks",
    get title() { return t("ht.name"); },
    order: 43,
    icon: ListChecks,
    searchTerms: ["happy", "tasks", "branch", "branch name", "template", "repository", "project", "agent"],
    component: lazy(() => import("./TasksSettings")),
  });
  registerCommand({ id: "tasks.show", get title() { return t("ht.cmd.show"); }, get group() { return t("ht.name"); }, keywords: ["happy", "assigned", "todo", "branch", "agent"], when: () => ntReady("tasks"), run: () => openDockTab("tasks") });
}
