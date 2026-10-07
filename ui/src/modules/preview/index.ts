import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { activeDockTab, dockVisible, registerDockTab, toggleDockTab } from "../../platform/dock";
import { registerRailItem } from "../../platform/rail";
import { registerSettingsSection } from "../../platform/settings";
import { registerTabType } from "../../platform/tabs";
import { Braces, Globe } from "../../ui-kit";
import { activeController, hasController } from "./controller";
import { componentPreviewEnabled } from "./toggle";

// Registry calls only: the view, the state and the catalog scan load with the first preview that is shown.
const actions = () => import("./actions");
const componentActions = () => import("./componentActions");

// Component preview (Stage B) is a Settings toggle: while it is off there is no tab type and no command, and none of its code loads.
let live: (() => void)[] = [];
let disposeToggle: (() => void) | undefined;

function activateComponentPreview(): void {
  if (live.length) return;
  live = [
    registerTabType({ type: "preview-component", get title() { return t("pvc.name"); }, icon: Braces, canClose: true, component: lazy(() => import("./ComponentTab")) }),
    registerCommand({
      id: "preview.component",
      get title() { return t("pvc.cmd.open"); },
      get group() { return t("pvc.cmd.group"); },
      keywords: ["component", "react", "props", "storybook", "isolated", "harness", "login", "list", "page"],
      run: async () => void (await componentActions()).previewActiveComponent(),
    }),
  ];
}

function deactivateComponentPreview(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerTabType({ type: "preview", get title() { return t("pv.name"); }, icon: Globe, canClose: true, component: lazy(() => import("./PreviewTab")) });
  registerDockTab({ id: "preview", get title() { return t("pv.name"); }, icon: Globe, component: lazy(() => import("./PreviewDock")) });
  registerRailItem({
    id: "preview",
    icon: Globe,
    get title() { return t("pv.name"); },
    order: 70,
    position: "left",
    run: () => toggleDockTab("preview"),
    pressed: () => dockVisible() && activeDockTab()?.id === "preview",
  });
  registerSettingsSection({ id: "preview", get title() { return t("pv.name"); }, order: 56, icon: Globe, searchTerms: ["preview", "device", "frame", "localhost", "loopback", "dev server"], component: lazy(() => import("./PreviewSettings")) });

  registerCommand({ id: "preview.open", get title() { return t("pv.cmd.open"); }, get group() { return t("pv.cmd.group"); }, keywords: ["run", "dev server", "localhost", "browser", "frame"], run: async () => void (await actions()).openPreviewForDefaultRepo() });
  registerCommand({ id: "preview.toggleDock", get title() { return t("pv.cmd.toggleDock"); }, get group() { return t("pv.cmd.group"); }, keywords: ["dock", "side"], run: () => toggleDockTab("preview") });
  registerCommand({ id: "preview.openForFile", get title() { return t("pv.cmd.openForFile"); }, get group() { return t("pv.cmd.group"); }, keywords: ["route", "page", "component"], run: async () => void (await actions()).openPreviewForFile() });
  registerCommand({ id: "preview.reload", get title() { return t("pv.cmd.reload"); }, get group() { return t("pv.cmd.group"); }, keywords: ["refresh"], when: hasController, run: () => activeController()?.reload() });
  registerCommand({ id: "preview.hardReload", get title() { return t("pv.cmd.hardReload"); }, get group() { return t("pv.cmd.group"); }, keywords: ["cache", "refresh"], when: hasController, run: () => activeController()?.hardReload() });
  registerCommand({ id: "preview.rotate", get title() { return t("pv.cmd.rotate"); }, get group() { return t("pv.cmd.group"); }, keywords: ["device", "landscape", "portrait"], when: hasController, run: () => activeController()?.rotate() });
  registerCommand({ id: "preview.focusUrl", get title() { return t("pv.cmd.focusUrl"); }, get group() { return t("pv.cmd.group"); }, keywords: ["url", "localhost", "port"], when: hasController, run: () => activeController()?.focusUrl() });
  disposeToggle?.();
  deactivateComponentPreview();
  disposeToggle = createRoot((dispose) => {
    createEffect(() => (componentPreviewEnabled() ? activateComponentPreview() : deactivateComponentPreview()));
    return dispose;
  });
}
