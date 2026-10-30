// Small pieces other modules mount into a run without the run views knowing them: buttons in the run header (Save point,
// Undo last step), cards at the top of the run's page (the run summary, the test result) and chips on the run card in the
// sessions list. A slot gets the run's row and renders nothing when it has nothing to say.
import type { Component } from "solid-js";
import type { AgentRow } from "../store/agents";
import { createRegistry } from "./registry";

export interface RunSlot {
  id: string;
  /** `header`: icon buttons in the run header; `top`: cards under the header; `card`: chips on the run card and the finished-run row
   *  (both are buttons themselves, so a `card` slot renders non-interactive content only: badges, text, icons). */
  place: "header" | "top" | "card";
  order: number;
  component: Component<{ agent: AgentRow }>;
}

const registry = createRegistry<RunSlot>((s) => s.order, "runSlots");

export const registerRunSlot = registry.register;
export const runSlots = (place: RunSlot["place"]): RunSlot[] => registry.items().filter((s) => s.place === place);
export const resetRunSlots = registry.clear;
