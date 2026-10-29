// Safety presets: Careful / Balanced / Autonomous above the permission cards of the New Run dialog and in Settings > Agents,
// each a plain-language name for an existing mode (Ask, Edit automatically, Automatic). Presets never lower a hard stop;
// Plan and Bypass stay on the cards, Bypass with its typed confirmation. Also offers the secret-in-diff check when it is off.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerNewRunSlot } from "../../platform/newRunSlots";
import { registerSettingsSection } from "../../platform/settings";
import { ShieldCheck } from "../../ui-kit";
import { presetsEnabled } from "./toggle";

let live: (() => void)[] = [];

function activate(): void {
  if (live.length) return;
  live = [registerNewRunSlot({ id: "presets.bar", place: "modes", order: 10, component: lazy(() => import("./PresetBar")) })];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  // The section stays when the bar is off: it is where the bar is switched back on, and it sets the default of every run.
  registerSettingsSection({ id: "agents", get title() { return t("presets.section.name"); }, order: 41, icon: ShieldCheck, searchTerms: ["agent", "safety", "preset", "careful", "balanced", "autonomous", "permission", "mode", "secret"], component: lazy(() => import("./AgentsSection")) });
  createRoot(() => createEffect(() => (presetsEnabled() ? activate() : deactivate())));
}
