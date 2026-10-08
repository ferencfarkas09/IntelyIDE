import { t } from "../../i18n";
import { appMode, showTabInAgent } from "../../platform/mode";
import { openTab } from "../../platform/tabs";

export const USAGE_TAB_ID = "usage";

/** One Usage tab: in Agent mode it shows in the middle of the Agent workspace, otherwise in the editor area (like the other agent views). */
export function openUsage(): string {
  const id = openTab({ type: "usage", id: USAGE_TAB_ID, title: t("usage.name") });
  if (appMode() === "agent") showTabInAgent(id);
  return id;
}
