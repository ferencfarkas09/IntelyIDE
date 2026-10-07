import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerOverlay } from "../../platform/overlay";
import { registerSettingsSection } from "../../platform/settings";
import { registerStatusItem } from "../../platform/statusbar";
import { Download } from "../../ui-kit";
import { chipVisible } from "./state";

// Update NOTIFICATION only (the app says a newer release exists and opens its page; it installs nothing). Registry calls only:
// the overlay (status read, event listeners, one-time disclosure) and the chip load lazily.
export function register(): void {
  registerOverlay({ id: "updates", component: lazy(() => import("./UpdatesWatcher")) });
  registerStatusItem({ id: "updates", align: "right", order: 2, component: lazy(() => import("./UpdateChip")), when: chipVisible });
  registerSettingsSection({ id: "updates", get title() { return t("updates.section.name"); }, order: 97, icon: Download, searchTerms: ["update", "version", "release", "download", "upgrade", "github"], component: lazy(() => import("./UpdatesSettings")) });
  registerCommand({
    id: "updates.check",
    get title() {
      return t("updates.cmd.check");
    },
    get group() {
      return t("updates.section.name");
    },
    keywords: ["update", "version", "release", "upgrade"],
    run: () => void import("./UpdatesWatcher").then((m) => m.manualCheckToast()),
  });
}
