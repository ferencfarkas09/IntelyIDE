// The Settings toggle of the Project notes panel; on by default (it only reads until the person presses Save).
import { createExtraToggle } from "../../platform/extraToggle";

const toggle = createExtraToggle("intely.extra.projectNotes", "projectNotes", true);
export const projectNotesEnabled = toggle.on;
export const setProjectNotesEnabled = toggle.set;
export const syncProjectNotesEnabled = toggle.sync;
