import { t } from "../../i18n";
import { openVisibleTab } from "../../platform/mode";

/** The one prompt library tab: in the middle of the Agent workspace in Agent mode, otherwise in the editor area. */
export const openPrompts = (): string => openVisibleTab({ type: "prompts", id: "prompts", title: t("prompts.name") });
