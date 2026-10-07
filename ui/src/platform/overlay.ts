import type { Component } from "solid-js";
import { createRegistry } from "./registry";

export interface Overlay {
  id: string;
  /** Mounted once under the shell, in every mode: dialogs and background watchers a module owns. */
  component: Component;
}

const registry = createRegistry<Overlay>(() => 0, "overlay");

export const registerOverlay = registry.register;
export const overlays = registry.items;
export const resetOverlays = registry.clear;
