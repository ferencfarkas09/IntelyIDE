import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { setToolWindow } from "../../platform/rail";
import { setCommitView, setPanelOpen } from "../../shell/layout";
import { selectedFile } from "../../store/selection";
import { repos } from "../../store/workspace";
import { rollbackTargets, stashTargets, stashTicked } from "./actions";
import { openDialog, setPopupRepo } from "./uiState";

/** The repo the user is working in: the one of the selected file, else the first. */
const activeRepoId = (): string | undefined => selectedFile()?.repoId ?? repos()[0]?.id;

const showStash = () => {
  setToolWindow("left", "commit");
  setPanelOpen(true);
  setCommitView("stash");
};

export function register(): void {
  registerCommand({ id: "branches.checkout", get title() { return t("branches.cmd.checkout"); }, group: "Git", keywords: ["checkout", "branch", "popup"], when: () => repos().length > 0, run: () => void setPopupRepo(activeRepoId() ?? null) });
  registerCommand({
    id: "branches.new",
    get title() {
      return t("branches.newBranchBtn");
    },
    group: "Git",
    keywords: ["create", "branch"],
    when: () => repos().length > 0,
    run: () => {
      const repoId = activeRepoId();
      if (repoId) openDialog({ kind: "newBranch", repoId });
    },
  });
  registerCommand({ id: "branches.switchAll", get title() { return t("branches.cmd.switchAll"); }, group: "Git", keywords: ["checkout", "every", "workspace"], when: () => repos().length > 0, run: () => openDialog({ kind: "switchAll" }) });
  registerCommand({
    id: "git.rollback",
    get title() {
      return t("branches.cmd.rollback");
    },
    group: "Git",
    keywords: ["revert", "discard", "undo changes"],
    shortcut: "Mod+Alt+Z",
    when: () => rollbackTargets().length > 0,
    run: () => openDialog({ kind: "rollback", targets: rollbackTargets() }),
  });
  registerCommand({ id: "stash.show", get title() { return t("branches.cmd.stashShow"); }, group: "Git", keywords: ["stash", "shelve"], run: showStash });
  registerCommand({ id: "stash.push", get title() { return t("branches.cmd.stashPush"); }, group: "Git", keywords: ["stash", "shelve"], when: () => stashTargets().length > 0, run: () => void stashTicked("").then(showStash) });
}
