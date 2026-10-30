import { t } from "../../i18n";
import { openVisibleTab } from "../../platform/mode";

export const DASHBOARD_TAB_ID = "dashboard";

/** Opens (or focuses) the one dashboard tab. */
export const openDashboard = (): string => openVisibleTab({ type: "dashboard", id: DASHBOARD_TAB_ID, title: t("dash.name") });
