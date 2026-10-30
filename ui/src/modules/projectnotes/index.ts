// Project notes: the CLAUDE.md of each repository, viewed, created and edited in place (atomic writes through the files
// backend, a symbolic link is never followed or replaced), and the exact CLAUDE.md files a Claude run started now is told,
// with the same caps and order as the sidecar. "Generate a starter with an agent" only opens the New Run dialog.
// A lazy extra that starts switched on, with a Settings toggle.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { requestNewRun } from "../../platform/newRun";
import { registerSettingsSection } from "../../platform/settings";
import { openTab, registerTabType } from "../../platform/tabs";
import { repoConfig, repos } from "../../store/workspace";
import { FileText } from "../../ui-kit";
import { starterPrompt } from "./logic";
import { projectNotesEnabled } from "./toggle";

let live: (() => void)[] = [];

const open = () => void openTab({ type: "projectnotes", id: "projectnotes", title: t("pnotes.name") });

function activate(): void {
  if (live.length) return;
  live = [
    registerTabType({ type: "projectnotes", get title() { return t("pnotes.name"); }, icon: FileText, component: lazy(() => import("./NotesTab")), canClose: true }),
    registerCommand({ id: "projectnotes.open", get title() { return t("pnotes.cmd.open"); }, get group() { return t("pnotes.name"); }, keywords: ["claude.md", "claude", "instructions", "memory", "rules", "context", "agent"], run: open }),
    registerCommand({
      id: "projectnotes.generate",
      get title() { return t("pnotes.cmd.generate"); },
      get group() { return t("pnotes.name"); },
      keywords: ["claude.md", "generate", "starter", "agent", "instructions"],
      when: () => repos().length > 0,
      run: () => {
        const id = repos()[0]?.id;
        if (id) void requestNewRun({ prompt: starterPrompt(repoConfig(id)?.name ?? id, false), repoIds: [id] });
      },
    }),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "projectnotes", get title() { return t("pnotes.section.name"); }, order: 106, icon: FileText, searchTerms: ["claude.md", "claude", "instructions", "project notes", "memory", "context"], component: lazy(() => import("./NotesSection")) });
  createRoot(() => createEffect(() => (projectNotesEnabled() ? activate() : deactivate())));
}
