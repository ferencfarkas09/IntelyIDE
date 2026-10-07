import { t } from "../../i18n";
import type { LucideIcon } from "lucide-solid";
import { lazy, type Component } from "solid-js";
import { Bot } from "../../ui-kit";

export interface DockTab {
  id: string;
  title: string;
  icon: LucideIcon;
  /** Lazy: nothing of a tab is fetched until it is first shown. */
  component: Component;
  shortcut?: string[];
}

const tabs: DockTab[] = [];

export function registerDockTab(tab: DockTab): void {
  if (!tabs.some((t) => t.id === tab.id)) tabs.push(tab);
}

export const dockTabs = (): readonly DockTab[] => tabs;

registerDockTab({
  id: "agents",
  get title() {
    return t("rail.agents");
  },
  icon: Bot,
  shortcut: ["⌘", "⇧", "A"],
  component: lazy(() => import("../../components/chat/ChatPanel").then((m) => ({ default: m.ChatPanel }))),
});
