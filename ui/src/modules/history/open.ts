import { t } from "../../i18n";
import { appMode, showTabInAgent } from "../../platform/mode";
import { openTab } from "../../platform/tabs";
import { cockpitTabId, SEARCH_TAB_ID } from "./format";

/** In Agent mode a tab shows in the middle of the Agent workspace; otherwise in the editor area (like the Inspector's own openers). */
function open(tab: Parameters<typeof openTab>[0]): string {
  const id = openTab(tab);
  if (appMode() === "agent") showTabInAgent(id);
  return id;
}

export const openSessionSearch = (): string => open({ type: "sessionsearch", id: SEARCH_TAB_ID, title: t("history.name") });

export const openCockpit = (run: { runId: string; title?: string; role?: string; repoIds?: string[] }): string => {
  const title = run.title && run.title.length > 24 ? `${run.title.slice(0, 23)}…` : run.title;
  return open({ type: "cockpit", id: cockpitTabId(run.runId), title: t("cockpit.tab", { title: title ?? run.runId }), params: { ...run } });
};
