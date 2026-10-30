import { createSignal, type Component } from "solid-js";
import type { LucideIcon } from "lucide-solid";
import { readStored, writeStored } from "../ui-kit/storage";
import { createRegistry } from "./registry";
import { activeTab, openTab, tabs, type TabInstance } from "./tabs";

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

export const resetModes = () => (registry.clear(), panelRegistry.clear(), setMode("editor"), setAgentTab(null), setPanelId(null));

/**
 * A tab (Run history, Inspector, Review) that is shown in the middle of the Agent workspace, so opening it from Agent mode
 * does not flip the app to Editor mode. The tab itself lives in the tab store like any other.
 */
const [agentTab, setAgentTab] = createSignal<string | null>(null);
export const agentTabId = agentTab;
export const showTabInAgent = setAgentTab;
/** Opens (or focuses) a tab where the person is looking: in the middle of the Agent workspace in Agent mode, else in the editor area. */
export function openVisibleTab(input: Parameters<typeof openTab>[0]): string {
  const id = openTab(input);
  if (appMode() === "agent") showTabInAgent(id);
  return id;
}
/** The tab on screen in the Agent workspace, or undefined (the run view shows). */
export const agentTabInstance = (): TabInstance | undefined => {
  const id = agentTab();
  return id && appMode() === "agent" ? tabs().find((t) => t.id === id) : undefined;
};
/** The tab the user is looking at: the Agent workspace's own, or the editor area's active one. */
export const visibleTab = (): TabInstance | undefined => (appMode() === "agent" ? agentTabInstance() : activeTab());

/**
 * A panel docked at the right edge of the Agent workspace, next to the run: Team chat is the first. The Agent workspace replaces
 * the editor area, so a dock tab opened there would only open behind it; a module that wants something usable beside a run
 * registers a panel and opens it with `openAgentPanel`. The open one is remembered.
 */
export interface AgentPanel {
  id: string;
  title: string;
  /** Lazy: fetched when the panel is first shown. Fills the column; `onClose` is given so the panel can offer its own close button in its header. */
  component: Component<{ onClose?: () => void }>;
  /** False while the thing it shows is off (no Happy account, say): the panel is then treated as closed. */
  when?: () => boolean;
}

const panelRegistry = createRegistry<AgentPanel>(() => 0, "agentPanel");
export const registerAgentPanel = panelRegistry.register;
export const agentPanel = (id: string): AgentPanel | undefined => panelRegistry.get(id);

const PANEL_KEY = "intely.layout.agentPanel";
const [panelId, setPanelId] = createSignal<string | null>(readStored(PANEL_KEY) || null);

/** The panel on screen: only in Agent mode, only a registered one, and only while its `when` allows. */
export const agentPanelId = (): string | null => {
  const id = panelId();
  const panel = id ? panelRegistry.get(id) : undefined;
  return appMode() === "agent" && panel && (panel.when?.() ?? true) ? panel.id : null;
};
export const agentPanelOpen = (id: string): boolean => agentPanelId() === id;

export function openAgentPanel(id: string): void {
  setPanelId(id);
  writeStored(PANEL_KEY, id);
}
export function closeAgentPanel(): void {
  setPanelId(null);
  writeStored(PANEL_KEY, "");
}
export const toggleAgentPanel = (id: string): void => (agentPanelOpen(id) ? closeAgentPanel() : openAgentPanel(id));
