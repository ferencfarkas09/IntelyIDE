// The Settings toggle of the prompt library; on by default (it only reads until the person saves a prompt).
import { createExtraToggle } from "../../platform/extraToggle";

const toggle = createExtraToggle("intely.extra.prompts", "prompts", true);
export const promptsEnabled = toggle.on;
export const setPromptsEnabled = toggle.set;
export const syncPromptsEnabled = toggle.sync;
