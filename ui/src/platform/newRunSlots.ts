// Small controls other modules mount into the New Run dialog without the dialog knowing them: the saved-prompt picker
// next to the prompt box, the safety presets above the permission cards. A slot only gets the context below; it can fill
// the form, never start a run.
import type { Component } from "solid-js";
import type { PermissionMode } from "../store/agent-types";
import { createRegistry } from "./registry";

export interface NewRunSlotContext {
  prompt(): string;
  setPrompt(text: string): void;
  repoIds(): readonly string[];
  /** The permission mode picked now. */
  permission(): PermissionMode;
  /** The same path a click on a mode card takes (Bypass still opens its typed confirmation). */
  pickMode(mode: PermissionMode): void;
  /** The modes the chosen provider offers, and the ones its gate refuses with the reason. */
  supported(): readonly PermissionMode[];
  unavailable(): Partial<Record<PermissionMode, string>>;
  disabled(): boolean;
}

export interface NewRunSlot {
  id: string;
  /** `modes`: above the permission cards; `prompt`: beside the prompt box. */
  place: "modes" | "prompt";
  order: number;
  component: Component<{ ctx: NewRunSlotContext }>;
}

const registry = createRegistry<NewRunSlot>((s) => s.order, "newRunSlots");

export const registerNewRunSlot = registry.register;
export const newRunSlots = (place: NewRunSlot["place"]): NewRunSlot[] => registry.items().filter((s) => s.place === place);
export const resetNewRunSlots = registry.clear;
