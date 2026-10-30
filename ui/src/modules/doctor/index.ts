// Setup doctor: Node 24, the Agent SDK, the Claude Code login, git, gh, the Xcode command line tools, CocoaPods, the Android
// SDK and watchman, each with why it matters and a copyable fix. Only looks: the probes run with a deadline on the login
// PATH, the agent rows come from the provider state the app keeps, and a fix is typed into a terminal only on request and
// never run without Return. A first-run card in the New Run dialog points here while the agent cannot start.
// A lazy extra that starts switched on, with a Settings toggle.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerNewRunSlot } from "../../platform/newRunSlots";
import { registerSettingsSection } from "../../platform/settings";
import { registerTabType } from "../../platform/tabs";
import { Wrench } from "../../ui-kit";
import { openDoctor } from "./open";
import { setupDoctorEnabled } from "./toggle";

let live: (() => void)[] = [];

function activate(): void {
  if (live.length) return;
  live = [
    registerTabType({ type: "doctor", get title() { return t("setup.name"); }, icon: Wrench, component: lazy(() => import("./DoctorTab")), canClose: true }),
    registerNewRunSlot({ id: "doctor.card", place: "modes", order: 0, component: lazy(() => import("./AgentSetupCard")) }),
    registerCommand({ id: "doctor.setup", get title() { return t("setup.cmd.open"); }, get group() { return t("setup.name"); }, keywords: ["setup", "doctor", "node", "sdk", "login", "xcode", "cocoapods", "android", "adb", "watchman", "install"], run: () => void openDoctor() }),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "setupdoctor", get title() { return t("setup.section.name"); }, order: 107, icon: Wrench, searchTerms: ["setup", "doctor", "node", "sdk", "xcode", "android", "install"], component: lazy(() => import("./DoctorSection")) });
  createRoot(() => createEffect(() => (setupDoctorEnabled() ? activate() : deactivate())));
}
