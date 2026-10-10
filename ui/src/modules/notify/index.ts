import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerOverlay } from "../../platform/overlay";
import { registerSettingsSection } from "../../platform/settings";
import { Bell } from "../../ui-kit";

// Registry calls only. The overlay reads the settings, watches the runs and feeds the Dock badge when it mounts.
export function register(): void {
  registerOverlay({ id: "notify", component: lazy(() => import("./NotifyWatcher")) });
  registerSettingsSection({
    id: "notify",
    get title() {
      return t("notify.section.name");
    },
    order: 49,
    icon: Bell,
    searchTerms: ["notification", "banner", "alert", "badge", "dock", "sound", "needs you", "finished", "question", "permission"],
    component: lazy(() => import("./NotifySection")),
  });
}
