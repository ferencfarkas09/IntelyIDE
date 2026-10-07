import { createEffect, lazy, on } from "solid-js";
import { needsYouCount } from "../store/agents";
import { commitAll, commitAndPush, fetchRepo, openPushDialog, pullRepo, pushDialogRequest } from "../store/actions";
import { refreshSnapshots } from "../store/snapshots";
import { workspace } from "../store/workspace";
import { selectedFile } from "../store/selection";
import { Bot, FileDiff, GitCommitHorizontal, Settings } from "../ui-kit";
import { registerCommand } from "../platform/commands";
import { t } from "../i18n";
import { dockVisible, activeDockTab, toggleDockTab } from "../platform/dock";
import { registerShortcut } from "../platform/keymap";
import { appMode, modeView, setAppMode } from "../platform/mode";
import { activeToolWindow, registerRailItem } from "../platform/rail";
import { openSettings } from "../platform/settings";
import { registerStatusItem } from "../platform/statusbar";
import { activateTab, cycleTab, openTab, registerTabType } from "../platform/tabs";
import { togglePalette } from "../platform/hosts/CommandPalette";
import { editorAreaFocused } from "../platform/hosts/EditorTabs";
import { registerPathPicker } from "../platform/pathpicker";
import { CommitToolWindow } from "./CommitToolWindow";
import { registerWorkspaceShell } from "./workspace/register";
import { diffPreview, panelOpen, panelVisible, setDiffPreview, setPanelOpen } from "./layout";
import { applyExtendedTemplate, draftMessage } from "../components/commit/generate";
import { AttentionItem, EnvItem, OpsItem, SelectionItem } from "../components/StatusBar/items";

/** Registers what the shell itself contributes to the platform registries. Idempotent: ids replace. */
export function registerBuiltins(): void {
  registerPathPicker();
  registerRailItem({ id: "commit", icon: GitCommitHorizontal, title: "Commit", shortcut: ["⌘", "0"], order: 20, position: "left", panel: CommitToolWindow });
  registerRailItem({
    id: "agents",
    icon: Bot,
    title: "Agents",
    shortcut: ["⌘", "⇧", "A"],
    order: 50,
    position: "left",
    run: () => (appMode() === "agent" ? setAppMode("editor") : toggleDockTab("agents")),
    pressed: () => appMode() === "agent" || (dockVisible() && activeDockTab()?.id === "agents"),
    badge: needsYouCount,
  });
  registerRailItem({ id: "settings", icon: Settings, title: "Settings", shortcut: ["⌘", ","], order: 100, position: "left", align: "end", run: () => openSettings() });

  registerTabType({ type: "diff", get title() { return t("tab.diff"); }, icon: FileDiff, canClose: false, component: lazy(() => import("./DiffTab")) });

  registerCommand({ id: "palette.open", get title() { return t("cmd.paletteOpen"); }, group: "View", keywords: ["palette", "command"], shortcut: "Cmd+Shift+P", noRecent: true, run: togglePalette });
  registerShortcut({ id: "palette.open:cmd-k", keys: "Cmd+K", command: "palette.open" });
  registerCommand({ id: "settings.open", get title() { return t("cmd.settings"); }, group: "View", keywords: ["preferences", "options"], shortcut: "Cmd+,", run: () => openSettings() });
  registerCommand({ id: "view.toggleCommitPanel", get title() { return t("cmd.toggleCommit"); }, group: "View", shortcut: "Cmd+0", run: () => setPanelOpen(!panelOpen()) });
  registerCommand({ id: "view.toggleDiffPreview", get title() { return t("cmd.toggleDiff"); }, group: "View", run: () => setDiffPreview(!diffPreview()) });
  registerCommand({ id: "view.modeAgent", get title() { return t("cmd.modeAgent"); }, group: "View", keywords: ["runs", "sessions"], when: () => !!modeView("agent") && appMode() !== "agent", run: () => setAppMode("agent") });
  registerCommand({ id: "view.modeEditor", get title() { return t("cmd.modeEditor"); }, group: "View", when: () => appMode() === "agent", run: () => setAppMode("editor") });
  registerCommand({ id: "view.toggleAgents", get title() { return t("cmd.toggleAgents"); }, group: "View", keywords: ["chat", "dock"], shortcut: "Cmd+Shift+A", run: () => toggleDockTab("agents") });
  registerCommand({ id: "git.refreshAll", get title() { return t("cmd.refreshAll"); }, group: "Git", keywords: ["status", "reload"], shortcut: "Cmd+R", run: () => refreshSnapshots(null) });
  registerCommand({ id: "commit.insertTemplate", get title() { return t("cmd.insertTemplate"); }, group: "Git", keywords: ["message", "magyar", "sections"], run: () => applyExtendedTemplate() });
  registerCommand({ id: "commit.draftMessage", get title() { return t("cmd.draft"); }, group: "Git", keywords: ["generate", "ai", "haiku"], run: () => draftMessage() });
  registerCommand({ id: "commit.run", get title() { return t("cmd.commit"); }, group: "Git", keywords: ["commit selected", "check in"], run: () => void commitAll() });
  registerCommand({ id: "commit.runAndPush", get title() { return t("commit.commitPush"); }, group: "Git", keywords: ["publish"], run: () => void commitAndPush() });
  registerCommand({ id: "push.open", get title() { return t("cmd.push"); }, group: "Git", keywords: ["publish", "upload", "remote"], run: () => openPushDialog() });
  registerCommand({ id: "git.fetchAll", get title() { return t("cmd.fetchAll"); }, group: "Git", keywords: ["remote", "update"], run: () => void Promise.all((workspace()?.repos ?? []).map((r) => fetchRepo(r.id))) });
  registerCommand({ id: "git.pullAll", get title() { return t("cmd.pullAll"); }, group: "Git", keywords: ["remote", "update"], run: () => void Promise.all((workspace()?.repos ?? []).map((r) => pullRepo(r.id))) });
  // The chords only act while the Commit panel is showing, so Cmd+Enter still reaches the editor and the terminal.
  const commitPanelShowing = () => appMode() === "editor" && activeToolWindow("left") === "commit" && panelVisible() && !pushDialogRequest();
  registerShortcut({ id: "commit.run:cmd-enter", keys: "Cmd+Enter", command: "commit.run", when: commitPanelShowing });
  registerShortcut({ id: "commit.runAndPush:cmd-alt-enter", keys: "Cmd+Alt+Enter", command: "commit.runAndPush", when: commitPanelShowing });
  registerShortcut({ id: "push.open:cmd-shift-k", keys: "Cmd+Shift+K", command: "push.open", when: commitPanelShowing });
  // Ctrl+Tab belongs to the terminal and the other panels while they have focus; the palette entries always work.
  registerCommand({ id: "tabs.next", get title() { return t("cmd.tabNext"); }, group: "Tabs", shortcut: "Ctrl+Tab", shortcutWhen: editorAreaFocused, run: () => cycleTab(1) });
  registerCommand({ id: "tabs.previous", get title() { return t("cmd.tabPrev"); }, group: "Tabs", shortcut: "Ctrl+Shift+Tab", shortcutWhen: editorAreaFocused, run: () => cycleTab(-1) });

  registerStatusItem({ id: "env", align: "left", order: 10, component: EnvItem });
  registerStatusItem({ id: "ops", align: "left", order: 20, component: OpsItem });
  registerStatusItem({ id: "attention", align: "right", order: 10, component: AttentionItem });
  registerStatusItem({ id: "selection", align: "right", order: 20, component: SelectionItem });

  registerWorkspaceShell();

  openTab({ type: "diff", id: "diff" });
}

/** Selecting a file in the Commit panel brings the diff tab to the front, whatever tab was active. Call inside a component. */
export function showDiffOnSelection(): void {
  createEffect(on(selectedFile, (file) => file && activateTab("diff"), { defer: true }));
}
