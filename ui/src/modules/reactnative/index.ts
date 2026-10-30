// React Native / Expo device loop: the project's status, Metro, simulators, emulators and devices, device logs and the errors
// found in them, for people who build by prompting an agent. A lazy extra that starts switched on; the panel only shows up
// where a React Native or Expo project is detected. Metro and the native builds are package.json scripts started through the
// Run panel's runner (ipc.run), so its safety rules apply.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { activeToolWindow, registerRailItem, setToolWindow } from "../../platform/rail";
import { registerSettingsSection } from "../../platform/settings";
import { repos } from "../../store/workspace";
import { Smartphone } from "../../ui-kit";
import { anyDetected, detectProjects } from "./detection";
import { reactNativeEnabled } from "./toggle";

let live: (() => void)[] = [];

function activate(): void {
  if (live.length) return;
  live = [
    registerRailItem({
      id: "reactnative",
      icon: Smartphone,
      get title() { return t("reactnative.title"); },
      order: 75,
      position: "bottom",
      ownHeader: true,
      panel: lazy(() => import("./ReactNativePanel")),
      when: anyDetected,
    }),
    registerCommand({
      id: "reactnative.show",
      get title() { return t("reactnative.cmd.toggle"); },
      get group() { return t("reactnative.title"); },
      keywords: ["react native", "expo", "metro", "simulator", "emulator", "ios", "android", "device", "logcat"],
      when: anyDetected,
      run: () => setToolWindow("bottom", activeToolWindow("bottom") === "reactnative" ? null : "reactnative"),
    }),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "reactnative", get title() { return t("reactnative.section.name"); }, order: 105, icon: Smartphone, searchTerms: ["react native", "expo", "metro", "simulator", "emulator"], component: lazy(() => import("./ReactNativeSection")) });
  createRoot(() =>
    createEffect(() => {
      if (!reactNativeEnabled()) return deactivate();
      activate();
      // Detection only reads small files of each repository; it runs again when the set of repositories changes.
      void detectProjects(repos().map((r) => r.id));
    }),
  );
}
