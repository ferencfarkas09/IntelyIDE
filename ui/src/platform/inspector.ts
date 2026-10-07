import type { Component } from "solid-js";
import { createRegistry } from "./registry";

export interface InspectorPanel {
  id: string;
  title: string;
  /** Sort key within the Inspector's tab strip. */
  order: number;
  /** Lazy: fetched when the tab is first shown. Reads the selected run from the stores. */
  component: Component;
}

const registry = createRegistry<InspectorPanel>((p) => p.order, "inspector");

/** The Inspector is the right-hand side of the Agent workspace; modules contribute its tabs. */
export const registerInspectorPanel = registry.register;
export const inspectorPanels = registry.items;
export const resetInspector = registry.clear;
