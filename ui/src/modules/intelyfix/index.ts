// IntelyFIX: one click on a Sentry issue assigns it, starts an agent on the right repository with the right prompt and links the run to the
// issue (the tab and the Sentry connection are `modules/sentry`). This module is the settings of that: how Fix starts, who gets the issue,
// which repository a Sentry project belongs to, and the prompt. It requests nothing: the Sentry side reads nothing until a token is set.
import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerSettingsSection } from "../../platform/settings";
import { Sparkles } from "../../ui-kit";

export function register(): void {
  registerSettingsSection({
    id: "intelyfix",
    get title() { return t("intelyfix.section.title"); },
    order: 102,
    icon: Sparkles,
    searchTerms: ["intelyfix", "fix", "autofix", "sentry", "prompt", "assign", "repository", "agent", "errors"],
    component: lazy(() => import("./IntelyFixSection")),
  });
}
