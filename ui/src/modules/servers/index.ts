import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerSettingsSection } from "../../platform/settings";
import { Server } from "../../ui-kit";

// Registry calls only: the servers are read when the section is opened, and nothing connects until the person asks.
export function register(): void {
  registerSettingsSection({
    id: "servers",
    get title() {
      return t("servers.section.name");
    },
    order: 47,
    icon: Server,
    searchTerms: ["server", "ssh", "remote", "host", "setup", "install", "node", "clone", "build server", "agents"],
    component: lazy(() => import("./ServersSection")),
  });
}
