import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { openSettings, registerSettingsSection } from "../../platform/settings";
import { registerStatusItem } from "../../platform/statusbar";
import { Smartphone } from "../../ui-kit";
import { isOn } from "./state";

/** IntelyIDE Remote ((design notes: remote-plan)): Settings > Remote, the status-bar chip with the kill switch, and the panic command.
 *  Registration touches no IPC: Remote is off until the user switches it on, and then costs one socket on the Rust side. */
export function register(): void {
  registerSettingsSection({
    id: "remote",
    get title() {
      return t("remote.name");
    },
    order: 48,
    icon: Smartphone,
    searchTerms: ["phone", "iphone", "pair", "qr", "relay", "devices", "kill switch", "panic", "pwa", "mobile"],
    component: lazy(() => import("./RemoteSection")),
  });
  registerStatusItem({ id: "remote-chip", align: "right", order: 20, component: lazy(() => import("./StatusChip")), when: isOn });
  registerCommand({ id: "remote.open", get title() { return t("remote.cmd.open"); }, get group() { return t("settings.title"); }, keywords: ["phone", "pair", "devices", "iphone"], run: () => openSettings("remote") });
  registerCommand({ id: "remote.relay", get title() { return t("remote.cmd.relay"); }, get group() { return t("settings.title"); }, keywords: ["cloudflare", "relay", "deploy", "worker", "wrangler", "own account"], run: () => openSettings("remote") });
  registerCommand({
    id: "remote.kill",
    get title() {
      return t("remote.cmd.kill");
    },
    get group() {
      return t("settings.title");
    },
    keywords: ["stop", "disconnect", "emergency", "phone"],
    when: isOn,
    run: async () => void (await (await import("./actions")).kill()),
  });
  registerCommand({
    id: "remote.panic",
    get title() {
      return t("remote.cmd.panic");
    },
    get group() {
      return t("settings.title");
    },
    keywords: ["revoke", "lock", "emergency", "phone", "lost"],
    when: isOn,
    run: async () => void (await (await import("./actions")).panic()),
  });
}
