import { t } from "../../i18n";
import { openTab } from "../../platform/tabs";

export const DASHBOARD_TAB_ID = "dashboard";

/** Opens (or focuses) the one dashboard tab. */
export const openDashboard = (): string => openTab({ type: "dashboard", id: DASHBOARD_TAB_ID, title: t("dash.name") });
