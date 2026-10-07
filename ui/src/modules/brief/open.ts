import { t } from "../../i18n";
import { appMode, showTabInAgent } from "../../platform/mode";
import { openTab } from "../../platform/tabs";
import { setView } from "./store";

export const NIGHT_TAB_ID = "nightqueue";

/** Opens the tab (in the Agent workspace when that mode is on), on the evening queue or the Morning brief. */
export function openNight(view: "queue" | "brief"): string {
  setView(view);
  const id = openTab({ type: "nightqueue", id: NIGHT_TAB_ID, title: t("night.name") });
  if (appMode() === "agent") showTabInAgent(id);
  return id;
}
