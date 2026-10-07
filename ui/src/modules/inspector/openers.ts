import { t } from "../../i18n";
import { appMode, showTabInAgent } from "../../platform/mode";
import { openTab } from "../../platform/tabs";
import type { RunParams } from "./useInspection";

/** In Agent mode the tab opens in the middle of the Agent workspace (the mode does not change); otherwise in the editor area. */
function open(tab: Parameters<typeof openTab>[0]): string {
  const id = openTab(tab);
  if (appMode() === "agent") showTabInAgent(id);
  return id;
}

const short = (title: string | undefined) => (title && title.length > 28 ? `${title.slice(0, 27)}…` : title);

export const inspectorTabId = (runId: string) => `inspector:${runId}`;
export const reviewTabId = (runId: string) => `review:${runId}`;

export function openInspector(run: RunParams): string {
  return open({ type: "inspector", id: inspectorTabId(run.runId), title: t("inspector.tab.inspect", { title: short(run.title) ?? run.runId }), params: { ...run } });
}

export function openReview(run: RunParams): string {
  return open({ type: "review", id: reviewTabId(run.runId), title: t("inspector.tab.review", { title: short(run.title) ?? run.runId }), params: { ...run } });
}

export const openHistory = (): string => open({ type: "history", id: "history" });
