import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerRailItem } from "../../platform/rail";
import { registerSettingsSection } from "../../platform/settings";
import { openTab, registerTabType } from "../../platform/tabs";
import { Users } from "../../ui-kit";

const tabTitle = () => `${t("team.tab.title")} (${t("team.beta")})`;
const openTeam = () => void openTab({ type: "team", id: "team", title: tabTitle() });

// Registry calls only: nothing is read or connected until the section or the tab is opened (the backend resumes an existing team by itself).
export function register(): void {
  registerSettingsSection({
    id: "team",
    get title() {
      return t("team.section.name");
    },
    order: 50,
    icon: Users,
    searchTerms: ["team", "collaboration", "invite", "members", "share", "colleagues", "presence", "relay", "revoke", "shared runs"],
    component: lazy(() => import("./TeamSection")),
  });
  registerTabType({ type: "team", get title() { return tabTitle(); }, icon: Users, canClose: true, component: lazy(() => import("./TeamTab")) });
  registerRailItem({ id: "team", icon: Users, get title() { return tabTitle(); }, order: 70, position: "left", run: openTeam });
  registerCommand({ id: "team.open", get title() { return t("team.cmd.open"); }, get group() { return t("team.section.name"); }, keywords: ["team", "colleagues", "shared runs", "teammates"], run: openTeam });
}
