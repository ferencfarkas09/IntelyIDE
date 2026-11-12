import { t } from "../../i18n";
import { openVisibleTab } from "../../platform/mode";

/** The one Mobile health tab: in the middle of the Agent workspace in Agent mode, otherwise in the editor area. */
export const openMobileHealth = (): string => openVisibleTab({ type: "mobilehealth", id: "mobilehealth", title: t("mobilehealth.name") });
