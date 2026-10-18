// The DeepPattern integration: DeepPattern's Decision Engine (a hosted second-opinion service by invitation, with its own installer and
// MCP server). This module shows where it stands (installed, activated, healthy), helps to install and activate it with its own installer,
// and starts an audit of the uncommitted changes through its MCP tools. IntelyIDE never holds the endpoint or the activation key.
import { lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { openIntegration, registerIntegration } from "../../platform/integrations";
import { requestNewRun } from "../../platform/newRun";
import { Sparkles } from "../../ui-kit";
import { AUDIT_PROMPT, cardStatus } from "./logic";
import { refreshStatus, status } from "./store";

export function register(): void {
  registerIntegration({
    id: "deeppattern",
    name: "DeepPattern",
    order: 40,
    icon: Sparkles,
    get summary() {
      return t("integrations.catalog.deeppattern.summary");
    },
    status: () => cardStatus(status()),
    load: () => void refreshStatus(),
    detail: lazy(() => import("./DeepPatternIntegration")),
  });
  registerCommand({
    id: "deeppattern.open",
    get title() {
      return t("dp.cmd.open");
    },
    get group() {
      return t("group.agents");
    },
    keywords: ["deeppattern", "decision engine", "audit", "review", "second opinion", "integration"],
    run: () => openIntegration("deeppattern"),
  });
  registerCommand({
    id: "deeppattern.audit",
    get title() {
      return t("dp.cmd.audit");
    },
    get group() {
      return t("group.agents");
    },
    keywords: ["deeppattern", "decision engine", "audit", "review", "second opinion", "changes", "diff"],
    run: () => void requestNewRun({ prompt: AUDIT_PROMPT }),
  });
}
