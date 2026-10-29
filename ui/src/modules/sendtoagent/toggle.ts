// The Settings toggle of "Fix with agent" / "Explain this error"; on by default (it only fills the New Run dialog).
import { createExtraToggle } from "../../platform/extraToggle";

const toggle = createExtraToggle("intely.extra.sendToAgent", "sendToAgent", true);
export const sendToAgentEnabled = toggle.on;
export const setSendToAgentEnabled = toggle.set;
export const syncSendToAgentEnabled = toggle.sync;
