import type { Component } from "solid-js";
import type { MessageKey } from "../../i18n";
import type { PermissionMode } from "../../store/agent-types";

/** The props the New run dialog gives the MCP picker ((design notes: mcp-management-spec) 7.7). */
export interface McpRunPickerProps {
  value: string[];
  onChange: (ids: string[]) => void;
  provider: string;
  mode: PermissionMode;
  workspaceId: string | null;
  disabled?: boolean;
}

interface PickerModule {
  McpRunPicker?: Component<McpRunPickerProps>;
  mcpStartIds?: (value: string[], provider: string) => string[];
}
interface LogicModule {
  mcpStartIds?: (value: string[], provider: string) => string[];
  mcpRunErrorKey?: (code: string) => MessageKey;
}

// The picker and its helpers belong to the MCP module, which this dialog does not own. The globs resolve to nothing until those files
// exist, so the dialog builds and runs without MCP, and picks them up (statically bundled) as soon as they land.
const picker = Object.values(import.meta.glob<PickerModule>("../mcp/McpRunPicker.tsx", { eager: true }))[0];
const logic = Object.values(import.meta.glob<LogicModule>("../mcp/logic.ts", { eager: true }))[0];

/** The picker component, or undefined while the MCP module has not delivered it (the dialog then mounts nothing and sends no `mcpServers`). */
export const McpRunPicker: Component<McpRunPickerProps> | undefined = picker?.McpRunPicker;
/** What goes into the request: the picked ids that still apply to this provider. */
export const mcpStartIds: (value: string[], provider: string) => string[] = picker?.mcpStartIds ?? logic?.mcpStartIds ?? (() => []);
/** The MCP catalog key for a start refusal caused by the selected servers. */
export const mcpRunErrorKey: ((code: string) => MessageKey) | undefined = logic?.mcpRunErrorKey;
