import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerOverlay } from "../../platform/overlay";
import LicensesHost from "../../shell/licenses/LicensesHost";
import { openLicenses } from "../../shell/licenses/open";

// Registry calls only: one command and the overlay host. No Ipc call, no timer; data and dialog load on first open.
export function register(): void {
  registerOverlay({ id: "licenses", component: LicensesHost });
  registerCommand({
    id: "licenses.show",
    get title() {
      return t("licenses.cmd.show");
    },
    get group() {
      return t("licenses.cmd.group");
    },
    keywords: ["license", "gpl", "third party", "open source", "notices"],
    run: () => {
      openLicenses();
    },
  });
}
