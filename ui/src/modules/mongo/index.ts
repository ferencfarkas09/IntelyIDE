import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerSettingsSection } from "../../platform/settings";
import { Database } from "../../ui-kit";
import { loadStatus } from "./gate";

/**
 * MongoDB Studio ((design notes: mongo-studio-plan)). Registers only the Settings > Database section; the rail item, the tab types,
 * the palette commands and every studio chunk appear when the master switch is on (see gate.tsx).
 */
export function register(): void {
  registerSettingsSection({
    id: "database",
    get title() {
      return t("mongo.section.title");
    },
    order: 44,
    icon: Database,
    searchTerms: ["mongodb", "mongo", "studio", "connection", "uri", "ai", "query", "compass", "privacy", "adatbázis"],
    component: lazy(() => import("./SettingsSection")),
  });
  void loadStatus();
}
