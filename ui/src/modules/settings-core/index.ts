import { createEffect, createRoot, lazy } from "solid-js";
import { ipc } from "../../ipc";
import { FileText, Info, Keyboard, Settings, ShieldCheck, Sun } from "../../ui-kit";
import { t, type MessageKey } from "../../i18n";
import { registerSettingsSection } from "../../platform/settings";
import { applyStoredAppearance, settleSkin } from "./appearance";
import { NS } from "./model";
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

/** The number of workspaces, once the registry has answered after boot (an empty registry = the Welcome screen). */
function firstRegistryCount(): Promise<number> {
  return import("../../store/workspaces").then(
    ({ registry }) =>
      new Promise<number>((resolve) =>
        createRoot((dispose) =>
          createEffect(() => {
            const reg = registry();
            if (reg) (dispose(), resolve(reg.workspaces.length));
          }),
        ),
      ),
  );
}

export function register(): void {
  applyStoredAppearance();
  void settleSkin({ read: () => ipc.settings.get(NS.appearance), write: (patch) => ipc.settings.set(NS.appearance, patch), workspaces: firstRegistryCount });
  applyStoredGeneral();
  section("general", 10, ["language", "hungarian", "magyar", "workspace", "repositories", "repos", "focus", "refresh", "colour", "color"], Settings, lazy(() => import("./GeneralSection")));
  section("appearance", 20, ["theme", "dark", "light", "accent", "density", "compact", "font", "size", "text", "style", "glass", "skin", "transparency", "blur"], Sun, lazy(() => import("./AppearanceSection")));
  section("editor", 30, ["tab", "indent", "wrap", "line numbers", "format"], FileText, lazy(() => import("./EditorSection")));
  section("safety", 50, ["live", "protected", "branch", "jail", "read-only", "secret", "never add", "guard"], ShieldCheck, lazy(() => import("./SafetySection")));
  section("keyboard", 60, ["shortcut", "keys", "hotkey", "binding", "conflict"], Keyboard, lazy(() => import("./KeyboardSection")));
  section("about", 90, ["version", "doctor", "logo", "licence", "license"], Info, lazy(() => import("./AboutSection")));
}
