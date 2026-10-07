import type { Component } from "solid-js";
import { createRegistry } from "./registry";

export interface StatusItem {
  id: string;
  /** `left` items sit before the flexible gap, `right` items after it. */
  align: "left" | "right";
  order: number;
  component: Component;
  /** Reactive visibility; the slot is not rendered at all while false. */
  when?: () => boolean;
}

const registry = createRegistry<StatusItem>((i) => i.order, "status");

export const registerStatusItem = registry.register;
/** Currently visible items of one side, in order. */
export const statusItems = (align: StatusItem["align"]): StatusItem[] => registry.items().filter((i) => i.align === align && (!i.when || i.when()));
export const resetStatusItems = registry.clear;
