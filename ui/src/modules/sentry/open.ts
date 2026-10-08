import { t } from "../../i18n";
import { appMode, showTabInAgent } from "../../platform/mode";
import { openTab } from "../../platform/tabs";

export const SENTRY_TAB_ID = "sentry";

/** One Sentry tab: in Agent mode it shows in the middle of the Agent workspace, otherwise in the editor area. */
export function openSentry(): string {
  const id = openTab({ type: "sentry", id: SENTRY_TAB_ID, title: t("sentry.name") });
  if (appMode() === "agent") showTabInAgent(id);
  return id;
}
