import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerOverlay } from "../../platform/overlay";

/** The What's new window: opens once after an update (the overlay decides at start) and on the command "What's new". */
export function register(): void {
  registerOverlay({ id: "whatsnew", component: lazy(() => import("./WhatsNew")) });
  registerCommand({
    id: "whatsnew.open",
    get title() {
      return t("whatsnew.cmd");
    },
    get group() {
      return t("updates.section.name");
    },
    keywords: ["release", "changelog", "news", "updates", "version", "újdonságok"],
    run: () => void import("./state").then((m) => m.openWhatsNew()),
  });
}
