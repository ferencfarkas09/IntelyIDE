// Safety presets: Careful / Balanced / Autonomous, each a plain-language name for an existing mode (Ask, Edit automatically,
// Automatic). While they are on, the New Run dialog names its permission cards after them and offers the secret-in-diff check
// when it is off (ui/src/modules/runs/NewRunDialog.tsx reads the toggle); Settings > Agents switches them and sets the default
// of every run. Presets never lower a hard stop; Plan and Bypass keep their own names, Bypass with its typed confirmation.
import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerSettingsSection } from "../../platform/settings";
import { ShieldCheck } from "../../ui-kit";

export function register(): void {
  // The section stays when the presets are off: it is where they are switched back on, and it sets the default of every run.
  registerSettingsSection({ id: "agents", get title() { return t("presets.section.name"); }, order: 41, icon: ShieldCheck, searchTerms: ["agent", "safety", "preset", "careful", "balanced", "autonomous", "permission", "mode", "secret"], component: lazy(() => import("./AgentsSection")) });
}
