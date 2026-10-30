// The Settings toggle of the Setup doctor; on by default (it only looks).
import { createExtraToggle } from "../../platform/extraToggle";

const toggle = createExtraToggle("intely.extra.setupDoctor", "setupDoctor", true);
export const setupDoctorEnabled = toggle.on;
export const setSetupDoctorEnabled = toggle.set;
export const syncSetupDoctorEnabled = toggle.sync;
