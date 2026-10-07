import { createSignal } from "solid-js";

/**
 * "Open this chip's menu" requests from the composer's slash commands. The chips of the run header listen for their own run and
 * target; `n` makes a repeated request (the same command twice) a new value.
 */
export type ChipTarget = "mcp" | "mode";
export interface ChipRequest {
  agentId: string;
  target: ChipTarget;
  n: number;
}

const [request, setRequest] = createSignal<ChipRequest | null>(null);
let counter = 0;

export const chipRequest = request;
export const requestChip = (agentId: string, target: ChipTarget): void => void setRequest({ agentId, target, n: ++counter });
export const resetChipRequests = (): void => void setRequest(null);
