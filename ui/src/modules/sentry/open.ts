import { t } from "../../i18n";
import { appMode, showTabInAgent } from "../../platform/mode";
import { openTab } from "../../platform/tabs";

export const SENTRY_TAB_ID = "sentry";

/** One IntelyFIX tab (the Sentry issues): in Agent mode it shows in the middle of the Agent workspace, otherwise in the editor area. */
export function openSentry(): string {
  const id = openTab({ type: "sentry", id: SENTRY_TAB_ID, title: t("intelyfix.name") });
  if (appMode() === "agent") showTabInAgent(id);
  return id;
}
