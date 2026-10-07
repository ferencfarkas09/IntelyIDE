import { lazy } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { registerCommand } from "../../platform/commands";
import { registerOverlay } from "../../platform/overlay";
import { registerSettingsSection } from "../../platform/settings";
import { registerStatusItem } from "../../platform/statusbar";
import { Cpu } from "../../ui-kit";
import { applyHudSettings, hudSettings, hudVisible } from "./state";

// Registry calls only. The overlay (settings read, Eco clock, tray bridge) and the chip load lazily; with every switch off the
// module has made no Ipc call beyond one settings read, started no timer and created no menu-bar icon.
export function register(): void {
  registerOverlay({ id: "hud", component: lazy(() => import("./HudWatcher")) });
  registerStatusItem({ id: "hud", align: "right", order: 3, component: lazy(() => import("./HudChip")), when: hudVisible });
  registerSettingsSection({ id: "hud", get title() { return t("hud.section.name"); }, order: 59, icon: Cpu, searchTerms: ["memory", "ram", "rss", "eco", "battery", "menu bar", "tray", "notification", "sidecar", "processes"], component: lazy(() => import("./HudSettings")) });
  registerCommand({
    id: "hud.toggle",
    get title() {
      return t("hud.cmd.toggle");
    },
    get group() {
      return t("hud.cmd.group");
    },
    keywords: ["memory", "ram", "hud", "status bar"],
    run: () => {
      const enabled = !hudSettings().enabled;
      applyHudSettings({ ...hudSettings(), enabled });
      void ipc.settings.set("hud", { enabled });
    },
  });
  registerCommand({
    id: "hud.eco",
    get title() {
      return t("hud.cmd.eco");
    },
    get group() {
      return t("hud.cmd.group");
    },
    keywords: ["eco", "battery", "background", "pause"],
    run: () => {
      const eco = !hudSettings().eco;
      applyHudSettings({ ...hudSettings(), eco });
      void ipc.settings.set("hud", { eco });
    },
  });
}
