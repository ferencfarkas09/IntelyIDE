// Run picker: the exact model and effort of a run, and ultracode, chosen in New run. The picker itself is a lazy component the dialog
// mounts while this extra is on (it starts on: untouched, it sends nothing and a run starts as before); this module adds its Settings
// toggle and a palette command that opens New run.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerSettingsSection } from "../../platform/settings";
import { Gauge } from "../../ui-kit";
import { setNewRunOpen } from "../runs/state";
import { runPickerEnabled } from "./toggle";

let live: (() => void)[] = [];

function activate(): void {
  if (live.length) return;
  live = [
    registerCommand({ id: "runpicker.newRun", get title() { return t("runpicker.cmd.newRun"); }, get group() { return t("group.agents"); }, keywords: ["model", "effort", "ultracode", "opus", "sonnet", "haiku", "workflow", "new run"], run: () => void setNewRunOpen(true) }),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "runpicker", get title() { return t("runpicker.section.name"); }, order: 105, icon: Gauge, searchTerms: ["model", "effort", "ultracode", "workflow", "opus", "sonnet"], component: lazy(() => import("./RunPickerSection")) });
  createRoot(() => createEffect(() => (runPickerEnabled() ? activate() : deactivate())));
}
