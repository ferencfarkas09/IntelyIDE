// A way for another screen (DeepPattern) to open Settings > MCP servers with the "Import from Claude Code" dialog already open.
import { createSignal } from "solid-js";
import { openSettings } from "../../platform/settings";

const [wanted, setWanted] = createSignal(false);

/** True from the request until the MCP section has opened the dialog. */
export const importRequested = wanted;
export function clearImportRequest(): void {
  setWanted(false);
}

export function openMcpImport(): void {
  setWanted(true);
  openSettings("mcp");
}
