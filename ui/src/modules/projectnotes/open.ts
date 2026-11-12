import { createSignal } from "solid-js";
import { t } from "../../i18n";
import { openVisibleTab } from "../../platform/mode";

/** The one Project notes tab: in the middle of the Agent workspace in Agent mode, otherwise in the editor area. */
export const openProjectNotes = (): string => openVisibleTab({ type: "projectnotes", id: "projectnotes", title: t("pnotes.name") });

const [notesRepo, setNotesRepo] = createSignal<string | undefined>();
/** The repository the Project notes tab shows (undefined while it is closed). */
export { notesRepo, setNotesRepo };
