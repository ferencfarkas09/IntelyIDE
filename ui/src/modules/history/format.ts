import { fmt, t } from "../../i18n";

export const usd = (n: number | undefined): string => (n === undefined ? t("cockpit.na") : `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`);
export const tokens = (n: number | undefined): string => (n === undefined ? t("cockpit.na") : fmt.number(Math.round(n), n >= 100_000 ? "compact" : undefined));

/** The tab that shows a run's context: one per run, in the centre (or in the Agent workspace). */
export const cockpitTabId = (runId: string): string => `cockpit:${runId}`;
export const SEARCH_TAB_ID = "sessionsearch";
