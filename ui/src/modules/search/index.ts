import { t } from "../../i18n";
import { lazy } from "solid-js";
import { registerCommand } from "../../platform/commands";
import { registerRailItem, setToolWindow } from "../../platform/rail";
import { setPanelOpen } from "../../shell/layout";
import { Search } from "../../ui-kit";
import { cancelSearch, requestFocus, setQuery, status, toggleCase, toggleRegex } from "./state";

const show = () => {
  setToolWindow("left", "search");
  setPanelOpen(true);
};

export function register(): void {
  registerRailItem({ id: "search", icon: Search, get title() { return t("search.title"); }, shortcut: ["⌘", "⇧", "F"], order: 40, position: "left", panel: lazy(() => import("./SearchPanel")) });
  registerCommand({ id: "search.focus", get title() { return t("search.findInFiles"); }, get group() { return t("search.title"); }, keywords: ["search", "grep", "everywhere"], shortcut: "Mod+Shift+F", run: () => void (show(), requestFocus()) });
  registerCommand({ id: "search.toggleRegex", get title() { return t("search.cmd.regex"); }, get group() { return t("search.title"); }, keywords: ["regex"], run: () => void (show(), toggleRegex()) });
  registerCommand({ id: "search.toggleCase", get title() { return t("search.cmd.case"); }, get group() { return t("search.title"); }, keywords: ["case sensitive"], run: () => void (show(), toggleCase()) });
  registerCommand({ id: "search.cancel", get title() { return t("search.cmd.cancel"); }, get group() { return t("search.title"); }, when: () => status() === "running", run: cancelSearch });
  registerCommand({ id: "search.clear", get title() { return t("search.cmd.clear"); }, get group() { return t("search.title"); }, run: () => setQuery("") });
}
