import { createSignal, type Component } from "solid-js";
import type { LucideIcon } from "lucide-solid";
import { createRegistry } from "./registry";

export interface SettingsSection {
  id: string;
  title: string;
  /** Sidebar position; built-ins use 10, 20, 30... */
  order: number;
  /** Lazy: nothing of a section is fetched until it is first shown. */
  component: Component;
  /** Words the dialog's search box matches besides the title, e.g. ["font size", "theme"]. */
  searchTerms: string[];
  icon?: LucideIcon;
}

const registry = createRegistry<SettingsSection>((s) => s.order, "settings");

export const registerSettingsSection = registry.register;
export const settingsSections = registry.items;

const [open, setOpen] = createSignal(false);
const [section, setSection] = createSignal<string | null>(null);

export const settingsOpen = open;
/** The section to show: the chosen one when it still exists, else the first. */
export const activeSettingsSection = (): SettingsSection | undefined => registry.get(section() ?? "") ?? registry.items()[0];

export function openSettings(sectionId?: string): void {
  if (sectionId) setSection(sectionId);
  setOpen(true);
}
export const closeSettings = () => setOpen(false);
export const selectSettingsSection = setSection;

/** Sections matching the search box (title or search terms, case-insensitive substring of every word). */
export function filterSections(query: string, list: readonly SettingsSection[] = registry.items()): SettingsSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return list.slice();
  return list.filter((s) => {
    const hay = [s.title, ...s.searchTerms].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export const resetSettings = () => (registry.clear(), setOpen(false), setSection(null));
