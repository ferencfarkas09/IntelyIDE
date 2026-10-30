// The Settings toggle of the safety presets above the permission cards; on by default.
import { createExtraToggle } from "../../platform/extraToggle";

const toggle = createExtraToggle("intely.extra.presets", "safetyPresets", true);
export const presetsEnabled = toggle.on;
export const setPresetsEnabled = toggle.set;
export const syncPresetsEnabled = toggle.sync;
