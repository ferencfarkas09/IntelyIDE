// The Settings toggle of this extra; on by default.
import { createExtraToggle } from "../../platform/extraToggle";

const toggle = createExtraToggle("intely.extra.checkpoints", "checkpoints", true);
export const checkpointsEnabled = toggle.on;
export const setCheckpointsEnabled = toggle.set;
export const syncCheckpointsEnabled = toggle.sync;
