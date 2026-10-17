import { lazy } from "solid-js";
import { t } from "../../i18n";
import type { HappyStatus } from "../../ipc/happy";
import { registerIntegration, type Integration, type IntegrationStatus } from "../../platform/integrations";
import { happyStatus, refreshHappyStatus } from "../../store/happy";
import { Smile, Sparkles } from "../../ui-kit";

const PARTS = ["timer", "meet", "chat", "notifications", "tasks"] as const;

/** The chip on the Happy card: whether the account is connected, and how many of its tools are switched on. */
export function happyCardStatus(status: HappyStatus | undefined): IntegrationStatus {
  if (!status) return { tone: "neutral", label: t("integrations.line.loading") };
  if (status.signedOut) return { tone: "danger", label: t("integrations.state.signedOut") };
  if (!status.tokenSaved) return { tone: "neutral", label: t("integrations.catalog.notConnected") };
  if (!status.user) return { tone: "info", label: t("integrations.line.tokenSaved") };
  const on = status.config.master ? PARTS.filter((id) => status.config[id].enabled).length : 0;
  return { tone: "ok", label: on > 0 ? t("integrations.catalog.connectedOn", { n: on }) : t("integrations.catalog.connected") };
}

const happy: Integration = {
  id: "happy",
  name: "Happy",
  order: 10,
  icon: Smile,
  get summary() {
    return t("integrations.catalog.happy.summary");
  },
  status: () => happyCardStatus(happyStatus()),
  load: () => void refreshHappyStatus().catch(() => {}),
  detail: lazy(() => import("./HappyIntegration")),
};

/** Announced in the catalog; the connection itself is not built yet, so the card opens nothing. */
const deepPattern: Integration = {
  id: "deeppattern",
  name: "DeepPattern",
  order: 40,
  icon: Sparkles,
  get summary() {
    return t("integrations.catalog.deeppattern.summary");
  },
  planned: true,
};

/** The entries this module owns. MCP servers and Sentry register their own cards from their modules; a later integration does the same. */
export function registerBuiltInIntegrations(): void {
  registerIntegration(happy);
  registerIntegration(deepPattern);
}
