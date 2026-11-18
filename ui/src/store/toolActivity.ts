import { createSignal } from "solid-js";

/**
 * How a run shows its tool calls (Settings > Appearance > Tool activity): `compact` folds the calls between two messages into one
 * quiet row (the default, like the Claude desktop app); `detailed` shows every call as its own card (the view before 1.16).
 * Stored with the appearance settings (settings.json and its local mirror), so it is per app, not per run.
 */
export type ToolActivity = "compact" | "detailed";
export const TOOL_ACTIVITY: readonly ToolActivity[] = ["compact", "detailed"];

const [toolActivity, setToolActivitySignal] = createSignal<ToolActivity>("compact");
export { toolActivity };
export const setToolActivity = (mode: ToolActivity): void => void setToolActivitySignal(mode);
