import type { LucideIcon } from "lucide-solid";
import { createSignal, type Component } from "solid-js";
import { panelOpen, panelVisible, setPanelOpen } from "../shell/layout";
import { readStored, writeStored } from "../ui-kit/storage";
import { createRegistry } from "./registry";

export interface RailItem {
  id: string;
  icon: LucideIcon;
  title: string;
  /** Key chips shown in the tooltip, e.g. ["⌘", "0"]. The binding itself is a command/shortcut. */
  shortcut?: string[];
  /** Sort key; the built-ins use 10, 20, 30...: Project 10, Commit 20, Graph 30, Search 40, Agents 50. */
  order: number;
  /** Where the tool window opens: next to the rail (`left`) or under the centre area (`bottom`). */
  position: "left" | "bottom";
  /** Lazy component rendered in the tool window. An item needs a `panel` or a `run`. */
  panel?: Component;
  /** Instead of a panel (Settings opens a dialog, Agents toggles the dock). */
  run?: () => void;
  /** A bottom panel that draws its own header (with a hide button); the host then skips its title row. */
  ownHeader?: boolean;
  /** Highlights the button for `run` items. */
  pressed?: () => boolean;
  /** Which end of the rail: `start` (default) is the top group, `end` sits at the bottom of the rail. */
  align?: "start" | "end";
  /** A count shown on the button (e.g. runs waiting for you); hidden at 0. Reactive. */
  badge?: () => number;
  /** Largest number written on the badge before it reads `N+` (default 9). */
  badgeMax?: number;
  /** The badge uses the danger tone (e.g. someone mentioned you). Reactive. */
  badgeUrgent?: () => boolean;
  /** The accessible name when it must say more than the title (e.g. "Team chat, 5 unread"); the tooltip keeps the title. Reactive. */
  label?: () => string;
  /** Hides the item while it returns false (a provider that is switched off or signed out). Reactive. */
  when?: () => boolean;
  /** A placeholder: shown dimmed with "(soon)", not clickable. The owning module re-registers the id without it. */
  soon?: boolean;
}

const registry = createRegistry<RailItem>((i) => i.order, "rail", (i) => !!i.soon);

export const registerRailItem = (item: RailItem) => {
  if (!item.soon && !item.panel && !item.run) throw new Error(`Rail item ${item.id} needs a panel or a run function`);
  return registry.register(item);
};
export const railItems = registry.items;
export const getRailItem = registry.get;

type Area = RailItem["position"];
const KEY = (area: Area) => `intely.layout.tool.${area}`;
const [active, setActive] = createSignal<Record<Area, string | null>>({ left: readStored(KEY("left")) ?? "commit", bottom: readStored(KEY("bottom")) });

/** The selected tool window of an area; the left area starts on Commit and is shown while `panelOpen()`, the bottom one is shown while non-null. */
export const activeToolWindow = (area: Area): string | null => active()[area];

export function setToolWindow(area: Area, id: string | null): void {
  setActive((a) => ({ ...a, [area]: id }));
  writeStored(KEY(area), id ?? "");
}

/** Rail click: opens the item's tool window, or closes it when it is already the open one. */
export function activateRailItem(item: RailItem): void {
  if (item.soon) return;
  if (!item.panel) return item.run?.();
  const same = activeToolWindow(item.position) === item.id;
  if (item.position === "bottom") return setToolWindow("bottom", same ? null : item.id);
  if (same && panelOpen()) return setPanelOpen(false);
  setToolWindow("left", item.id);
  setPanelOpen(true);
}

export const isRailItemPressed = (item: RailItem): boolean =>
  item.panel ? activeToolWindow(item.position) === item.id && (item.position === "bottom" || panelVisible()) : (item.pressed?.() ?? false);

export const resetRail = () => (registry.clear(), setActive({ left: "commit", bottom: null }));
