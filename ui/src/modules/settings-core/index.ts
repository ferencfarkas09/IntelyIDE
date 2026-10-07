import { lazy } from "solid-js";
import { FileText, Info, Keyboard, Settings, ShieldCheck, Sun } from "../../ui-kit";
import { t, type MessageKey } from "../../i18n";
import { registerSettingsSection } from "../../platform/settings";
import { applyStoredAppearance } from "./appearance";
import { applyStoredGeneral } from "./general";

function section(id: string, order: number, searchTerms: string[], icon: typeof Settings, component: ReturnType<typeof lazy>) {
  registerSettingsSection({
    id,
    order,
    searchTerms,
    icon,
    component,
    // A getter, so the sidebar and heading follow the language.
    get title() {
      return t(`section.${id}` as MessageKey);
    },
  });
}

export function register(): void {
  applyStoredAppearance();
  applyStoredGeneral();
  section("general", 10, ["language", "hungarian", "magyar", "workspace", "repositories", "repos", "focus", "refresh", "colour", "color"], Settings, lazy(() => import("./GeneralSection")));
  section("appearance", 20, ["theme", "dark", "light", "accent", "density", "compact", "font", "size", "text"], Sun, lazy(() => import("./AppearanceSection")));
  section("editor", 30, ["tab", "indent", "wrap", "line numbers", "format"], FileText, lazy(() => import("./EditorSection")));
  section("safety", 50, ["live", "protected", "branch", "jail", "read-only", "secret", "never add", "guard"], ShieldCheck, lazy(() => import("./SafetySection")));
  section("keyboard", 60, ["shortcut", "keys", "hotkey", "binding", "conflict"], Keyboard, lazy(() => import("./KeyboardSection")));
  section("about", 90, ["version", "doctor", "logo", "licence", "license"], Info, lazy(() => import("./AboutSection")));
}
