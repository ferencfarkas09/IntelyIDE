import { lazy } from "solid-js";
import { Bot } from "../../ui-kit";
import { t } from "../../i18n";
import { registerSettingsSection } from "../../platform/settings";

export function register(): void {
  registerSettingsSection({
    id: "providers",
    order: 40,
    searchTerms: ["claude", "codex", "gemini", "copilot", "opencode", "goose", "qwen", "acp", "capabilities", "openai", "ollama", "api key", "token", "model", "enforcement", "keychain"],
    icon: Bot,
    component: lazy(() => import("./ProvidersSection")),
    get title() {
      return t("section.providers");
    },
  });
}
