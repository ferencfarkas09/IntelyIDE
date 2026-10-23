// Account & data: the first-start screen that asks (once, and again only when the privacy notice changes) whether to register this
// computer with the IntelyIDE registry, and the Settings page where the person sees what is stored, turns the newsletter on or off, and
// deletes everything. Nothing is requested before the person agreed; the Rust side is `crates/registry`.
import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerOverlay } from "../../platform/overlay";
import { openSettings, registerSettingsSection } from "../../platform/settings";
import { UserRound } from "../../ui-kit";

export function register(): void {
  registerOverlay({ id: "account", component: lazy(() => import("./RegisterDialog")) });
  registerSettingsSection({
    id: "account",
    get title() {
      return t("account.section.title");
    },
    order: 103,
    icon: UserRound,
    searchTerms: ["account", "register", "registration", "newsletter", "email", "privacy", "data", "delete", "fingerprint", "regisztráció", "hírlevél", "adatok"],
    component: lazy(() => import("./AccountSection")),
  });
  registerCommand({
    id: "account.open",
    get title() {
      return t("account.cmd.open");
    },
    get group() {
      return t("account.section.title");
    },
    keywords: ["account", "register", "newsletter", "privacy", "delete my data"],
    run: () => openSettings("account"),
  });
}
