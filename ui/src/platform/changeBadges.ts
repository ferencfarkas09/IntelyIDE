import type { Component } from "solid-js";
import { createRegistry } from "./registry";

export interface ChangeBadgeSlot {
  id: string;
  /** Rendered after the file name of a row in the Changes tree. Must render nothing when it has nothing to say. */
  component: Component<{ repoId: string; path: string }>;
}

const registry = createRegistry<ChangeBadgeSlot>(() => 0, "change-badge");

/** A module adds a small badge to Changes tree file rows (the localization checker shows missing translations). */
export const registerChangeBadge = registry.register;
export const changeBadgeSlots = registry.items;
export const resetChangeBadges = registry.clear;
