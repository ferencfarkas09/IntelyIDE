// State of the DeepPattern screen and card, at module level: the catalog and the screen read the same facts.
import { createSignal } from "solid-js";
import { ipc } from "../../ipc";
import type { McpServerView } from "../../ipc/mcp";
import { activeId } from "../../store/workspaces";
import { deepPatternApi } from "./api";
import { findMcpServer } from "./logic";
import type { DpStatus } from "./types";

const [status, setStatus] = createSignal<DpStatus | undefined>(undefined);
const [mcpServer, setMcpServer] = createSignal<McpServerView | undefined>(undefined);

export { mcpServer, status };

/** Reads the engine's folder (files only). A failure leaves the card without a chip. */
export async function refreshStatus(): Promise<void> {
  try {
    setStatus(await deepPatternApi().status());
  } catch {
    /* nothing to show */
  }
}

/** Looks for DeepPattern among the MCP servers of the open workspace. */
export async function refreshMcp(): Promise<void> {
  try {
    setMcpServer(findMcpServer((await ipc.mcp.list(activeId())).servers));
  } catch {
    setMcpServer(undefined);
  }
}

export function resetDeepPattern(): void {
  setStatus(undefined);
  setMcpServer(undefined);
}
