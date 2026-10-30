// The Settings toggle of this extra; on by default.
import { createExtraToggle } from "../../platform/extraToggle";

const toggle = createExtraToggle("intely.extra.autotest", "autotest", true);
export const autotestEnabled = toggle.on;
export const setAutotestEnabled = toggle.set;
export const syncAutotestEnabled = toggle.sync;
