import { t } from "../../i18n";
import { openVisibleTab } from "../../platform/mode";

/** The one Setup doctor tab: in the middle of the Agent workspace in Agent mode, otherwise in the editor area. */
export const openDoctor = (): string => openVisibleTab({ type: "doctor", id: "doctor", title: t("setup.name") });
