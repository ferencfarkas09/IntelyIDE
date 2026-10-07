import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { activeToolWindow, registerRailItem, setToolWindow } from "../../platform/rail";
import { registerStatusItem } from "../../platform/statusbar";
import { liveServers, wireDevServers } from "../../store/devservers";
import { Play } from "../../ui-kit";

const show = () => setToolWindow("bottom", "run");
// The store (catalogs, logs, dialogs) loads with the first use, not with the module.
const store = () => import("./store");

export function register(): void {
  // Servers are only ever started by a click in the panel; this listener just keeps the rail badge and status chip true.
  wireDevServers();
  registerRailItem({ id: "run", icon: Play, get title() { return t("run.title"); }, order: 70, position: "bottom", ownHeader: true, panel: lazy(() => import("./RunPanel")) });
  registerStatusItem({ id: "run", align: "left", order: 30, component: lazy(() => import("./StatusItem")), when: () => liveServers().length > 0 });
  registerCommand({
    id: "run.show",
    get title() {
      return t("run.cmd.toggle");
    },
    get group() {
      return t("run.title");
    },
    keywords: ["scripts", "dev server", "start", "npm"],
    run: () => (activeToolWindow("bottom") === "run" ? setToolWindow("bottom", null) : show()),
  });
  registerCommand({
    id: "run.runScript",
    get title() {
      return t("run.cmd.runScript");
    },
    get group() {
      return t("run.title");
    },
    keywords: ["start", "dev server", "npm", "yarn", "script"],
    run: async () => {
      show();
      (await store()).requestFilterFocus();
    },
  });
  registerCommand({ id: "run.stopAll", get title() { return t("run.cmd.stopAll"); }, get group() { return t("run.title"); }, keywords: ["kill", "servers"], when: () => liveServers().length > 0, run: async () => (await store()).stopAll() });
}
