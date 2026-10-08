// The Sentry integration: the issues of one organization with filters and search, one issue with its newest event, and "Fix with
// agent" (assign to me, start a run, offer "Mark as resolved" when it is done). A tab, a command and a Settings section; nothing is
// requested until a token and an organization are saved and the tab is opened.
import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerSettingsSection } from "../../platform/settings";
import { registerTabType } from "../../platform/tabs";
import { Bug } from "../../ui-kit";
import { openSentry } from "./open";

export function register(): void {
  registerTabType({ type: "sentry", get title() { return t("sentry.name"); }, icon: Bug, component: lazy(() => import("./SentryTab")), canClose: true });
  registerCommand({
    id: "sentry.open",
    get title() { return t("sentry.cmd.open"); },
    get group() { return t("group.agents"); },
    keywords: ["sentry", "issues", "errors", "exceptions", "crash", "bugs", "fix", "monitoring"],
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
}
