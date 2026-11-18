// Small controls other modules mount into the context cockpit (modules/history) without the cockpit knowing them: a button
// next to a warning, a card under the context window, a line under the usage tiles. A slot gets what the cockpit already
// computed; it can ask the person to act, never act on its own from here.
import type { Component } from "solid-js";
import { createRegistry } from "./registry";

/** What the cockpit computed for one run (the structural part of `modules/history/cockpit.ts`'s `Cockpit`). */
export interface CockpitData {
  context: { used?: number; size?: number; fraction?: number; source: "reported" | "estimated" | "unknown" };
  totals?: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; costUsd?: number };
  files: readonly { path: string; reads: number; edits: number; readChars: number }[];
}

export interface CockpitWarningData {
  kind: string;
  params: Record<string, string | number>;
}

export type CockpitSlotProps = { runId: string; data: CockpitData; warning?: CockpitWarningData };

export interface CockpitSlot {
  id: string;
  /** `warning`: beside each warning (gets `warning`); `context`: under the window card; `usage`: under the usage tiles. */
  place: "warning" | "context" | "usage";
  order: number;
  component: Component<CockpitSlotProps>;
}

const registry = createRegistry<CockpitSlot>((s) => s.order, "cockpitSlots");

export const registerCockpitSlot = registry.register;
export const cockpitSlots = (place: CockpitSlot["place"]): CockpitSlot[] => registry.items().filter((s) => s.place === place);
export const resetCockpitSlots = registry.clear;
