// Project notes: the CLAUDE.md of each repository, viewed, created and edited in place (atomic writes through the files
// backend, a symbolic link is never followed or replaced), and the exact CLAUDE.md files a Claude run started now is told,
// with the same caps and order as the sidecar. "Generate a starter with an agent" only opens the New Run dialog.
// A lazy extra that starts switched on, with a Settings toggle.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { visibleTab } from "../../platform/mode";
import { requestNewRun } from "../../platform/newRun";
import { registerSettingsSection } from "../../platform/settings";
import { registerTabType } from "../../platform/tabs";
import { repoConfig, repos } from "../../store/workspace";
import { FileText, toast } from "../../ui-kit";
import { starterPrompt, starterTarget } from "./logic";
import { notesRepo, openProjectNotes } from "./open";
import { projectNotesEnabled } from "./toggle";

let live: (() => void)[] = [];

/** The repository on screen gets the starter; with several and none on screen, Project notes opens to pick one there. */
export async function generateStarter(): Promise<void> {
  const id = starterTarget(visibleTab(), notesRepo(), repos().map((r) => r.id));
  if (!id) {
    openProjectNotes();
    toast.info(t("pnotes.pickRepo"));
    return;
  }
  // Ask: the agent reads untrusted repository text, so every edit and command waits for a yes (as from the tab's own button)
  const ok = await requestNewRun({ prompt: starterPrompt(repoConfig(id)?.name ?? id, false), repoIds: [id], permission: "ask" });
  if (!ok) toast.warn(t("pnotes.noDialog"));
}

function activate(): void {
  if (live.length) return;
  live = [
    registerTabType({ type: "projectnotes", get title() { return t("pnotes.name"); }, icon: FileText, component: lazy(() => import("./NotesTab")), canClose: true }),
    registerCommand({ id: "projectnotes.open", get title() { return t("pnotes.cmd.open"); }, get group() { return t("pnotes.name"); }, keywords: ["claude.md", "claude", "instructions", "memory", "rules", "context", "agent"], run: () => void openProjectNotes() }),
    registerCommand({
      id: "projectnotes.generate",
      get title() { return t("pnotes.cmd.generate"); },
      get group() { return t("pnotes.name"); },
      keywords: ["claude.md", "generate", "starter", "agent", "instructions"],
      when: () => repos().length > 0,
      run: generateStarter,
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
