// Session search (Wave 4, backlog #15) and the context cockpit (#14): a full-text search across every agent run (prompts,
// replies, tools, files, repo, role, model) built lazily from the JSONL logs, and a per-run panel of what the context
// holds (window fill, usage per turn and per tool, files, attachments, warnings). A lazy extra with a Settings toggle:
// while it is off only the Settings section exists, nothing is loaded, indexed or drawn.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerInspectorPanel } from "../../platform/inspector";
import { registerSettingsSection } from "../../platform/settings";
import { registerTabType } from "../../platform/tabs";
import { agentRow, selectedAgentId } from "../../store/agents";
import { Gauge, History, Search } from "../../ui-kit";
import { openCockpit, openSessionSearch } from "./open";
import { sessionSearchEnabled } from "./toggle";

let live: (() => void)[] = [];

function selectedRun() {
  const id = selectedAgentId();
  const row = id ? agentRow(id) : undefined;
  return row ? { runId: row.agentId, title: row.title, role: row.role, repoIds: row.repoIds } : undefined;
}

function activate(): void {
  if (live.length) return;
  live = [
    registerTabType({ type: "sessionsearch", get title() { return t("history.name"); }, icon: Search, component: lazy(() => import("./SearchTab")), canClose: true }),
    registerTabType({ type: "cockpit", get title() { return t("cockpit.name"); }, icon: Gauge, component: lazy(() => import("./CockpitTab")), canClose: true }),
    registerInspectorPanel({ id: "context", get title() { return t("cockpit.name"); }, order: 30, component: lazy(() => import("./CockpitPanel")) }),
    registerCommand({ id: "history.search", get title() { return t("history.cmd.search"); }, get group() { return t("group.agents"); }, keywords: ["session", "sessions", "history", "find", "prompt", "transcript", "full text"], run: () => void openSessionSearch() }),
    registerCommand({ id: "history.cockpit", get title() { return t("history.cmd.cockpit"); }, get group() { return t("group.agents"); }, keywords: ["context", "tokens", "window", "cost", "files read"], when: () => !!selectedRun(), run: () => { const r = selectedRun(); if (r) void openCockpit(r); } }),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "history", get title() { return t("history.section.name"); }, order: 98, icon: History, searchTerms: ["search", "session", "transcript", "context", "tokens", "cost", "window"], component: lazy(() => import("./HistorySection")) });
  createRoot(() => createEffect(() => (sessionSearchEnabled() ? activate() : deactivate())));
}
