import { createSignal, type Component } from "solid-js";
import type { LucideIcon } from "lucide-solid";
import { readStored, writeStored } from "../ui-kit/storage";
import { createRegistry } from "./registry";
import { activeTab, tabs, type TabInstance } from "./tabs";

export type AppMode = "editor" | "agent";

export interface ModeView {
  /** Only "agent" exists; the editor workspace is the shell itself. */
  id: "agent";
  title: string;
  icon?: LucideIcon;
  /** Lazy: fetched when the mode is first entered. Fills the area next to the rail. */
  component: Component;
}

const registry = createRegistry<ModeView>(() => 0, "mode");

export const registerModeView = registry.register;
export const modeView = (id: ModeView["id"]): ModeView | undefined => registry.get(id);

/** `?mode=agent` opens the agent workspace for screenshots and manual checks. */
const fromUrl = new URLSearchParams(globalThis.location?.search).get("mode");
const [mode, setMode] = createSignal<AppMode>(fromUrl === "agent" || fromUrl === "editor" ? fromUrl : readStored("intely.layout.mode") === "agent" ? "agent" : "editor");

/** The mode the title bar shows; `agent` only counts while a module has registered the agent workspace. */
export const appMode = (): AppMode => (mode() === "agent" && registry.get("agent") ? "agent" : "editor");

export function setAppMode(next: AppMode): void {
  setMode(next);
  writeStored("intely.layout.mode", next);
}

export const resetModes = () => (registry.clear(), setMode("editor"), setAgentTab(null));

/**
 * A tab (Run history, Inspector, Review) that is shown in the middle of the Agent workspace, so opening it from Agent mode
 * does not flip the app to Editor mode. The tab itself lives in the tab store like any other.
 */
const [agentTab, setAgentTab] = createSignal<string | null>(null);
export const agentTabId = agentTab;
export const showTabInAgent = setAgentTab;
/** The tab on screen in the Agent workspace, or undefined (the run view shows). */
export const agentTabInstance = (): TabInstance | undefined => {
  const id = agentTab();
  return id && appMode() === "agent" ? tabs().find((t) => t.id === id) : undefined;
};
/** The tab the user is looking at: the Agent workspace's own, or the editor area's active one. */
export const visibleTab = (): TabInstance | undefined => (appMode() === "agent" ? agentTabInstance() : activeTab());
