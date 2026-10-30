// Mobile health panel: a read-only check of the iOS and Android parts of a repository (signing, versions, permissions,
// Gradle and Pods, store readiness) in plain language, with a button that hands each problem to a coding agent.
// A lazy extra that starts switched on, with a Settings toggle; the command appears only when a repository of the
// workspace holds an iOS or Android project.
import { createEffect, createRoot, lazy, on } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerSettingsSection } from "../../platform/settings";
import { registerTabType } from "../../platform/tabs";
import { repos } from "../../store/workspace";
import { Smartphone } from "../../ui-kit";
import { mobileRepos, refreshDetected } from "./api";
import { openMobileHealth } from "./open";
import { mobilehealthEnabled } from "./toggle";

let live: (() => void)[] = [];

function activate(): void {
  if (live.length) return;
  live = [
    registerTabType({ type: "mobilehealth", get title() { return t("mobilehealth.name"); }, icon: Smartphone, component: lazy(() => import("./MobileHealthTab")), canClose: true }),
    registerCommand({
      id: "mobilehealth.open",
      get title() { return t("mobilehealth.cmd.open"); },
      get group() { return t("mobilehealth.name"); },
      keywords: ["mobile", "ios", "android", "xcode", "gradle", "signing", "bundle id", "permissions", "store", "app store", "play store", "react native", "expo", "pods"],
      when: () => mobileRepos().length > 0,
      run: () => void openMobileHealth(),
    }),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "mobilehealth", get title() { return t("mobilehealth.section.name"); }, order: 112, icon: Smartphone, searchTerms: ["mobile", "ios", "android", "xcode", "gradle", "store"], component: lazy(() => import("./MobileHealthSection")) });
  createRoot(() => {
    createEffect(() => (mobilehealthEnabled() ? activate() : deactivate()));
    // folder names only: cheap enough to look again whenever the set of repositories changes
    createEffect(on(() => (mobilehealthEnabled() ? repos().map((r) => r.id).join(",") : undefined), (k) => void (k !== undefined && refreshDetected())));
  });
}
