import { createEffect, createRoot, on } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import type { Disposer } from "../../platform/registry";
import { activeId, activeSummary, duplicateWorkspace, isPinned, requestSwitch, switcherRecents, workspaces } from "../../store/workspaces";
import { toast } from "../../ui-kit";
import { workspaceErrorText } from "./errors";
import { uniqueName } from "./format";
import { openNewWorkspace, openManage, openScan, setSwitcherOpen, type ScanRequest } from "./dialogs";
import { addRepoFlow, openFolderFlow } from "./flows";

const GROUP = "Workspace";
const open = (): boolean => activeId() !== null && !isPinned();
const notPinned = (): boolean => !isPinned();

interface NewArgs {
  prefill?: import("../../ipc/picker").Picked[];
}

/** The static commands of the Workspace group (3.14). The chords are dropped by the keymap's conflict report when they clash. */
export function registerWorkspaceCommands(): Disposer {
  const off: Disposer[] = [
    registerCommand({ id: "workspace.open", get title() { return t("switch.open"); }, group: GROUP, keywords: ["folder", "repository", "project"], shortcut: "Cmd+O", run: () => openFolderFlow() }),
    registerCommand({ id: "workspace.new", get title() { return t("switch.new"); }, group: GROUP, keywords: ["create", "project"], shortcut: "Cmd+Alt+N", when: notPinned, run: (args) => void openNewWorkspace((args as NewArgs | undefined) ?? {}) }),
    registerCommand({ id: "workspace.scan", get title() { return t("switch.scan"); }, group: GROUP, keywords: ["find", "repositories", "folder"], when: notPinned, run: (args) => void openScan({ target: "new", ...((args as ScanRequest | undefined) ?? {}) }) }),
    registerCommand({ id: "workspace.addRepo", get title() { return t("switch.add"); }, group: GROUP, keywords: ["repository", "folder"], shortcut: "Cmd+Shift+O", when: open, run: () => void addRepoFlow() }),
    registerCommand({ id: "workspace.switch", get title() { return t("switch.switchTitle"); }, group: GROUP, keywords: ["workspace", "recent", "change"], shortcut: "Cmd+Alt+O", run: () => void setSwitcherOpen(true) }),
    registerCommand({ id: "workspace.manage", get title() { return t("switch.manage"); }, group: GROUP, when: notPinned, run: () => openManage() }),
    registerCommand({ id: "workspace.rename", get title() { return t("switch.renameCurrent"); }, group: GROUP, when: open, run: () => openManage({ id: activeId() ?? undefined, action: "rename" }) }),
    registerCommand({ id: "workspace.recolor", get title() { return t("switch.recolorCurrent"); }, group: GROUP, when: open, run: () => openManage({ id: activeId() ?? undefined, action: "recolor" }) }),
    registerCommand({
      id: "workspace.duplicate",
      get title() { return t("switch.duplicateCurrent"); },
      group: GROUP,
      when: open,
      run: async () => {
        const w = activeSummary();
        if (!w) return;
        try {
          const e = await duplicateWorkspace(w.id, uniqueName(t("manage.copyName", { name: w.name }), workspaces().map((x) => x.name)));
          toast.success(t("ws.toast.duplicated", { name: e.name }));
        } catch (err) {
          toast.error(workspaceErrorText(err));
        }
      },
    }),
    registerCommand({ id: "workspace.close", get title() { return t("switch.close"); }, group: GROUP, when: open, run: () => void requestSwitch(null) }),
    registerCommand({ id: "workspace.remove", get title() { return t("switch.removeCurrent"); }, group: GROUP, when: open, run: () => openManage({ id: activeId() ?? undefined, action: "remove" }) }),
  ];
  return () => off.forEach((d) => d());
}

/**
 * One "Switch to workspace: {name}" command per recent workspace (at most eight), re-registered when the list or the
 * language changes; the disposers of the previous set run first.
 */
let stopDynamic: Disposer | undefined;

export function registerDynamicWorkspaceCommands(): Disposer {
  stopDynamic?.();
  let current: Disposer[] = [];
  const dispose = createRoot((d) => {
    createEffect(
      on(
        () => [switcherRecents().map((w) => `${w.id}:${w.name}`).join("|"), activeId(), isPinned()] as const,
        () => {
          current.forEach((o) => o());
          current = switcherRecents()
            .filter((w) => w.id !== activeId())
            .map((w) =>
              registerCommand({
                id: `workspace.open.${w.id}`,
                get title() { return t("switch.openNamed", { name: w.name }); },
                group: GROUP,
                keywords: ["switch", "workspace", w.name],
                when: notPinned,
                run: () => void requestSwitch(w.id),
              }),
            );
        },
      ),
    );
    return d;
  });
  stopDynamic = () => {
    dispose();
    current.forEach((o) => o());
    current = [];
    stopDynamic = undefined;
  };
  return stopDynamic;
}
