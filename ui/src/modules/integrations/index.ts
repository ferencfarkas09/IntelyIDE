import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerOverlay } from "../../platform/overlay";
import { openIntegrations } from "../../platform/integrations";
import { registerSettingsSection } from "../../platform/settings";
import { registerStatusItem } from "../../platform/statusbar";
import { signedOutNotice } from "../../store/happy";
import { Plug } from "../../ui-kit";
import { registerBuiltInIntegrations } from "./catalog";

/** Settings > Integrations: the catalog (Happy, and the cards other modules add), the Happy watcher and the sign-out notice. */
export function register(): void {
  registerSettingsSection({
    id: "integrations",
    get title() {
      return t("integrations.title");
    },
    order: 42,
    icon: Plug,
    searchTerms: ["integration", "catalog", "connect", "happy", "token", "time tracer", "timer", "meet", "meeting", "sandbox", "production", "connection", "account", "deeppattern", "mcp", "sentry"],
    component: lazy(() => import("./IntegrationsSection")),
  });
  registerBuiltInIntegrations();
  registerOverlay({ id: "happy-watch", component: lazy(() => import("./Watcher")) });
  registerStatusItem({ id: "happy-signedout", align: "left", order: 30, component: lazy(() => import("./SignedOutNotice")), when: () => !!signedOutNotice() });
  registerCommand({ id: "integrations.open", get title() { return t("integrations.cmdOpen"); }, get group() { return t("rail.settings"); }, keywords: ["happy", "token", "connect", "timer", "meet", "deeppattern", "sentry", "mcp"], run: openIntegrations });
}
