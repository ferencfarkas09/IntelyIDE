import { t } from "../../i18n";
import { lazy } from "solid-js";
import { registerCommand } from "../../platform/commands";
import { registerShortcut } from "../../platform/keymap";
import { activeToolWindow, registerRailItem, setToolWindow } from "../../platform/rail";
import { SquareTerminal } from "../../ui-kit";

const open = () => activeToolWindow("bottom") === "terminal";
// The store (xterm, ipc) loads with the first terminal, not with the module.
const store = () => import("./store");

export function register(): void {
  registerRailItem({ id: "terminal", icon: SquareTerminal, get title() { return t("term.title"); }, shortcut: ["⌘", "J"], order: 60, position: "bottom", ownHeader: true, panel: lazy(() => import("./TerminalPanel")) });
  registerCommand({
    id: "terminal.toggle",
    get title() {
      return t("term.toggle");
    },
    group: "View",
    keywords: ["shell", "console", "command line"],
    shortcut: "Cmd+J",
    run: () => setToolWindow("bottom", open() ? null : "terminal"),
  });
  // The backquote key moves on other layouts (it is the 0 key on the Hungarian one), so Cmd+J is the primary chord.
  registerShortcut({ id: "terminal.toggle.alt", keys: "Ctrl+`", command: "terminal.toggle" });
  registerCommand({ id: "terminal.new", get title() { return t("term.new"); }, get group() { return t("term.title"); }, keywords: ["shell", "open"], run: async () => void (await store()).openTerminal({ repoId: (await store()).defaultRepoId() }) });
  registerCommand({ id: "terminal.close", get title() { return t("term.closeCmd"); }, get group() { return t("term.title"); }, when: open, run: async () => void (await store()).closeActive() });
  registerCommand({ id: "terminal.next", get title() { return t("term.next"); }, get group() { return t("term.title"); }, when: open, run: async () => void (await store()).cycleTerminal(1) });
  registerCommand({ id: "terminal.previous", get title() { return t("term.prev"); }, get group() { return t("term.title"); }, when: open, run: async () => void (await store()).cycleTerminal(-1) });
}
