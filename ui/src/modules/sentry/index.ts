// The Sentry integration and the IntelyFIX tab: the issues of one organization with filters and search, one issue with its newest event,
// and one-click Fix (assign, start a run with the right prompt, offer "Mark as resolved" when it is done; see `modules/intelyfix`). A tab, a
// command and a Settings section; nothing is requested until a token and an organization are saved and the tab is opened.
import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerIntegration } from "../../platform/integrations";
import { registerSettingsSection } from "../../platform/settings";
import { registerTabType } from "../../platform/tabs";
import { Bug } from "../../ui-kit";
import { openSentry } from "./open";
import { sentryApi } from "./api";
import { setConfigStatus, status } from "./store";

export function register(): void {
  registerTabType({ type: "sentry", get title() { return t("intelyfix.name"); }, icon: Bug, component: lazy(() => import("./SentryTab")), canClose: true });
  registerCommand({
    id: "sentry.open",
    get title() { return t("intelyfix.cmd.open"); },
    get group() { return t("group.agents"); },
    keywords: ["intelyfix", "sentry", "issues", "errors", "exceptions", "crash", "bugs", "fix", "autofix", "monitoring"],
    run: () => void openSentry(),
  });
  registerSettingsSection({
    id: "sentry",
    get title() { return t("sentry.name"); },
    order: 101,
    icon: Bug,
    searchTerms: ["sentry", "issues", "errors", "token", "organization", "monitoring"],
    component: lazy(() => import("./SentrySection")),
  });
  registerIntegration({
    id: "sentry",
    name: "Sentry",
    order: 30,
    icon: Bug,
    section: "sentry",
    get summary() {
      return t("integrations.catalog.sentry.summary");
    },
    status: () => (status()?.configured ? { tone: "ok", label: t("integrations.catalog.connected") } : { tone: "neutral", label: t("integrations.catalog.notConnected") }),
    // (read here, not through loadStatus: a failure belongs to the catalog, which shows no chip then, not to the problem line of the Sentry tab)
    load: () => void sentryApi().status().then(setConfigStatus, () => {}),
  });
}
