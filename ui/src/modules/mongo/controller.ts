// The mounted collection tabs register what the palette commands may drive. The target is the controller of the active tab.
import { createSignal } from "solid-js";
import { activeTab } from "../../platform/tabs";

export interface CollectionController {
  tabId: string;
  focusAi(): void;
  /** Runs the generated query when a draft is waiting for review, else Find. */
  run(): void;
  /** Find, ignoring a pending draft. */
  find(): void;
  reset(): void;
  cancel(): void;
  explain(): void;
  discard(): void;
  refreshSchema(): void;
  setView(view: "table" | "tree" | "json"): void;
  hasDraft(): boolean;
  loading(): boolean;
}

const [controllers, setControllers] = createSignal<readonly CollectionController[]>([]);

export function registerController(c: CollectionController): () => void {
  setControllers((all) => [...all, c]);
  return () => setControllers((all) => all.filter((x) => x !== c));
}

/** The controller of the active tab, if that tab is a collection tab. */
export const activeController = (): CollectionController | undefined => {
  const id = activeTab()?.id;
  return id ? controllers().find((c) => c.tabId === id) : undefined;
};
export const hasController = (): boolean => !!activeController();
