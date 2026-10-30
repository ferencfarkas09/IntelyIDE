// The Settings toggle of this extra; on by default.
import { createExtraToggle } from "../../platform/extraToggle";

const toggle = createExtraToggle("intely.extra.runSummary", "runSummary", true);
export const runSummaryEnabled = toggle.on;
export const setRunSummaryEnabled = toggle.set;
export const syncRunSummaryEnabled = toggle.sync;
