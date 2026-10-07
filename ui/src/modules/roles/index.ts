import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerSettingsSection } from "../../platform/settings";
import { Bot } from "../../ui-kit";

export function register(): void {
  registerSettingsSection({
    id: "roles",
    get title() {
      return t("roles.title");
    },
    order: 45,
    icon: Bot,
    searchTerms: ["agent", "model", "effort", "permission", "tools", "provider", "tiering", "haiku", "sonnet", "opus"],
    component: lazy(() => import("./RolesSection")),
  });
}
