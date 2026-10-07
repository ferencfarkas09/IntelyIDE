import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerUnsavedSource } from "../../platform/closeGuard";
import { appMode } from "../../platform/mode";
import { activateRailItem, getRailItem, registerRailItem } from "../../platform/rail";
import { activeTab, canCloseTab, closeTab, registerTabType, tabs } from "../../platform/tabs";
import { FileText, FolderGit2 } from "../../ui-kit";
import { activeFileTab, currentRepoId, newEntry, revealInProject } from "./actions";
import { beforeCloseFile, dirtyTabIds, openFile, saveAll, saveBuffer, viewOf } from "./buffers";
import { toggleWrap } from "./prefs";
import { openQuickOpen } from "./quickOpen";

const onFile = () => !!activeFileTab();
const withView = (run: (view: NonNullable<ReturnType<typeof viewOf>>) => void | Promise<unknown>) => () => {
  const tab = activeFileTab();
  const view = tab && viewOf(tab.id);
  if (view) run(view);
};

export function register(): void {
  registerRailItem({ id: "project", icon: FolderGit2, get title() { return t("editor.rail.project"); }, shortcut: ["⌘", "1"], order: 10, position: "left", panel: lazy(() => import("./ProjectPanel")) });
  registerTabType({ type: "file", get title() { return t("editor.tab.file"); }, icon: FileText, canClose: true, beforeClose: beforeCloseFile, component: lazy(() => import("./FileTab")) });

  registerCommand({ id: "view.toggleProject", get title() { return t("editor.cmd.toggleProject"); }, get group() { return t("group.view"); }, keywords: ["files", "explorer"], shortcut: "Cmd+1", run: () => activateRailItem(getRailItem("project")!) });
  registerCommand({
    id: "editor.openFile",
    get title() { return t("editor.cmd.openFile"); },
    get group() { return t("group.file"); },
    keywords: ["open", "quick open", "find file"],
    shortcut: "Cmd+P",
    // Other modules open a file at a line with execute("editor.openFile", { repoId, path, line }).
    run: (args) => {
      const a = args as { repoId?: string; path?: string; line?: number; column?: number } | undefined;
      if (a?.repoId && a.path) openFile(a.repoId, a.path, { line: a.line, column: a.column });
      else openQuickOpen();
    },
  });
  registerCommand({ id: "editor.newFile", get title() { return t("editor.cmd.newFile"); }, get group() { return t("group.file"); }, keywords: ["create"], run: () => { const repoId = currentRepoId(); if (repoId) void newEntry(repoId, "", "file"); } });
  registerCommand({ id: "editor.save", get title() { return t("editor.cmd.save"); }, get group() { return t("group.file"); }, shortcut: "Cmd+S", when: onFile, run: () => void saveBuffer(activeTab()!.id) });
  registerCommand({ id: "editor.saveAll", get title() { return t("editor.cmd.saveAll"); }, get group() { return t("group.file"); }, shortcut: "Cmd+Shift+S", run: () => saveAll() });
  // Cmd+W closes the active tab, never the window (the native menu has no Cmd+W); a pinned tab and the Agent view ignore it.
  registerCommand({
    id: "editor.closeTab",
    get title() { return t("editor.cmd.closeTab"); },
    get group() { return t("group.file"); },
    shortcut: "Cmd+W",
    when: () => appMode() === "editor" && !!activeTab() && canCloseTab(activeTab()!),
    run: () => void closeTab(activeTab()!.id),
  });
  registerUnsavedSource({
    id: "editor",
    titles: () => dirtyTabIds().map((id) => tabs().find((t) => t.id === id)?.title ?? id),
    saveAll: async () => (await saveAll(), dirtyTabIds().length === 0),
  });
  registerCommand({ id: "editor.gotoLine", get title() { return t("editor.cmd.gotoLine"); }, get group() { return t("group.edit"); }, keywords: ["jump"], shortcut: "Ctrl+G", when: onFile, run: withView(async (v) => (v.focus(), (await import("@codemirror/search")).gotoLine(v))) });
  registerCommand({ id: "editor.find", get title() { return t("editor.cmd.find"); }, get group() { return t("group.edit"); }, keywords: ["search", "replace"], when: onFile, run: withView(async (v) => (v.focus(), (await import("@codemirror/search")).openSearchPanel(v))) });
  registerCommand({ id: "editor.toggleWrap", get title() { return t("editor.cmd.toggleWrap"); }, get group() { return t("group.view"); }, keywords: ["word wrap", "line wrap"], when: onFile, run: toggleWrap });
  registerCommand({ id: "editor.revealInProject", get title() { return t("editor.cmd.revealInProject"); }, get group() { return t("group.view"); }, keywords: ["locate", "select"], when: onFile, run: () => { const t = activeFileTab()!; return revealInProject(String(t.params?.repoId), String(t.params?.path)); } });
}
