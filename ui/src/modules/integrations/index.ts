import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerOverlay } from "../../platform/overlay";
import { registerSettingsSection, openSettings } from "../../platform/settings";
import { registerStatusItem } from "../../platform/statusbar";
import { signedOutNotice } from "../../store/happy";
import { Plug } from "../../ui-kit";

/** Happy integrations framework ((design notes: integrations-plan) 1): Settings > Integrations, the watcher and the sign-out notice. */
export function register(): void {
  registerSettingsSection({
    id: "integrations",
    get title() {
      return t("integrations.title");
    },
    order: 42,
    icon: Plug,
    searchTerms: ["happy", "token", "time tracer", "timer", "meet", "meeting", "sandbox", "production", "connection", "account"],
    component: lazy(() => import("./IntegrationsSection")),
  });
  registerOverlay({ id: "happy-watch", component: lazy(() => import("./Watcher")) });
  registerStatusItem({ id: "happy-signedout", align: "left", order: 30, component: lazy(() => import("./SignedOutNotice")), when: () => !!signedOutNotice() });
  registerCommand({ id: "integrations.open", get title() { return t("integrations.cmdOpen"); }, get group() { return t("rail.settings"); }, keywords: ["happy", "token", "connect", "timer", "meet"], run: () => openSettings("integrations") });
}
