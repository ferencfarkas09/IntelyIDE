// Versions panel: the version of every repository of the workspace (package.json, Xcode and Android build numbers,
// Cargo, Tauri, Expo, pyproject, pubspec) in one place, changed together and written only when the person says so.
// A lazy extra that starts switched on, with a Settings toggle.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerSettingsSection } from "../../platform/settings";
import { openTab, registerTabType } from "../../platform/tabs";
import { Hash } from "../../ui-kit";
import { versionsEnabled } from "./toggle";

let live: (() => void)[] = [];

function activate(): void {
  if (live.length) return;
  live = [
    registerTabType({ type: "versions", get title() { return t("versions.name"); }, icon: Hash, component: lazy(() => import("./VersionsTab")), canClose: true }),
    registerCommand({ id: "versions.open", get title() { return t("versions.cmd.open"); }, get group() { return t("versions.name"); }, keywords: ["version", "bump", "build number", "ios", "android", "package.json", "release"], run: () => void openTab({ type: "versions", id: "versions", title: t("versions.name") }) }),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "versions", get title() { return t("versions.section.name"); }, order: 104, icon: Hash, searchTerms: ["version", "bump", "build number", "ios", "android", "package.json"], component: lazy(() => import("./VersionsSection")) });
  createRoot(() => createEffect(() => (versionsEnabled() ? activate() : deactivate())));
}
