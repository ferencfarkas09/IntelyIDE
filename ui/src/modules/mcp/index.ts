import { lazy } from "solid-js";
import { Plug } from "../../ui-kit";
import { t } from "../../i18n";
import { registerSettingsSection } from "../../platform/settings";

export function register(): void {
  registerSettingsSection({
    id: "mcp",
    order: 46,
    icon: Plug,
    searchTerms: ["mcp", "model context protocol", "server", "tools", "stdio", "http", "environment", "header", "secret", "keychain", "import", "claude code"],
    component: lazy(() => import("./McpSection")),
    get title() {
      return t("mcp.title");
    },
  });
}
