import { lazy } from "solid-js";
import { t } from "../../i18n";
import { activeToolWindow, registerRailItem, setToolWindow } from "../../platform/rail";
import { registerCommand } from "../../platform/commands";
import { registerEditorExtension } from "../../platform/editor-ext";
import { registerStatusItem } from "../../platform/statusbar";
import { activeTab, registerTabType } from "../../platform/tabs";
import { FileDiff, GitBranch, GitGraph, History, ListChecks, toast } from "../../ui-kit";
import { toggleBlame } from "./blame";
import { currentFile, fileFromArgs } from "./currentFile";
import { reloadLog, selection, setCherryConfirm } from "./logState";
import { openHistory, openHunks, openMatrix } from "./openers";
import { openRebase } from "./rebaseState";

const showLog = (): void => setToolWindow("bottom", "graph");

/** Focuses the search field once the (lazy) Log panel has rendered it. */
function focusSearch(): void {
  showLog();
  let tries = 0;
  const poll = () => {
    const field = document.querySelector<HTMLInputElement>("input[data-log-search]");
    if (field) field.focus();
    else if (tries++ < 40) setTimeout(poll, 50);
  };
  poll();
}

export function register(): void {
  registerRailItem({ id: "graph", icon: GitGraph, get title() { return t("graph.log.title"); }, shortcut: ["⌘", "9"], order: 30, position: "bottom", panel: lazy(() => import("./LogPanel")) });

  registerTabType({ type: "commitdiff", get title() { return t("graph.tab.commitDiff"); }, icon: FileDiff, canClose: true, component: lazy(() => import("./commitDiffTab")) });
  registerTabType({ type: "hunks", get title() { return t("graph.tab.hunks"); }, icon: ListChecks, canClose: true, component: lazy(() => import("./HunksTab")) });
  registerTabType({ type: "filehistory", get title() { return t("graph.tab.fileHistory"); }, icon: History, canClose: true, component: lazy(() => import("./HistoryTab")) });
  registerTabType({ type: "matrix", get title() { return t("graph.tab.branches"); }, icon: GitBranch, canClose: true, component: lazy(() => import("./matrixTab")) });

  registerEditorExtension({
    id: "graph.blame",
    when: (file) => !!file.repoId,
    extension: async (file) => (await import("./blameExtension")).blameExtension(file),
  });
  registerStatusItem({ id: "graph.blame", align: "right", order: 30, component: lazy(() => import("./BlameStatus")), when: () => activeTab()?.type === "file" });

  registerCommand({
    id: "graph.toggleLog",
    get title() { return t("graph.cmd.toggleLog"); },
    get group() { return t("group.git"); },
    keywords: ["history", "commits", "graph"],
    shortcut: "Mod+9",
    run: () => setToolWindow("bottom", activeToolWindow("bottom") === "graph" ? null : "graph"),
  });
  registerCommand({ id: "graph.search", get title() { return t("graph.cmd.search"); }, get group() { return t("group.git"); }, keywords: ["log", "find", "hash", "message"], run: focusSearch });
  registerCommand({ id: "graph.refresh", get title() { return t("graph.cmd.refresh"); }, get group() { return t("group.git"); }, keywords: ["reload", "commits"], run: () => (showLog(), reloadLog()) });
  registerCommand({
    id: "graph.cherryPick",
    get title() { return t("graph.cmd.cherryPick"); },
    get group() { return t("group.git"); },
    keywords: ["apply", "commit"],
    run: () => {
      showLog();
      if (!selection()) return void toast.info(t("graph.cmd.selectFirst"));
      setCherryConfirm(true);
    },
  });
  registerCommand({ id: "graph.rebase", get title() { return t("graph.cmd.rebase"); }, get group() { return t("group.git"); }, keywords: ["squash", "reword", "fixup", "reorder", "drop"], run: () => openRebase() });
  registerCommand({ id: "graph.matrix", get title() { return t("graph.cmd.matrix"); }, get group() { return t("group.git"); }, keywords: ["matrix", "switch", "create", "bundle", "ahead", "behind"], run: () => void openMatrix() });
  registerCommand({
    id: "graph.toggleBlame",
    get title() { return t("graph.cmd.blame"); },
    get group() { return t("group.git"); },
    keywords: ["annotate", "author", "gutter"],
    shortcut: "Mod+Alt+B",
    run: toggleBlame,
  });
  registerCommand({
    id: "graph.fileHistory",
    get title() { return t("graph.cmd.fileHistory"); },
    get group() { return t("group.git"); },
    keywords: ["log", "commits", "file"],
    when: () => currentFile() !== null,
    run: (args) => {
      const file = fileFromArgs(args);
      if (file) openHistory(file.repoId, file.path);
    },
  });
  registerCommand({
    id: "graph.hunks",
    get title() { return t("graph.cmd.hunks"); },
    get group() { return t("group.git"); },
    keywords: ["stage", "partial", "revert", "diff"],
    when: () => currentFile() !== null,
    run: (args) => {
      const file = fileFromArgs(args);
      if (file) openHunks(file.repoId, file.path);
    },
  });
}
