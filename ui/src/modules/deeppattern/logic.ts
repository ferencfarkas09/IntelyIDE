// What the DeepPattern screen says, as pure functions of the status, the check and the MCP list.
import { t } from "../../i18n";
import type { McpServerView } from "../../ipc/mcp";
import type { IntegrationStatus } from "../../platform/integrations";
import type { Tone } from "../../ui-kit";
import type { DpStatus, DpVerdict } from "./types";

/** The chip on the catalog card. */
export function cardStatus(status: DpStatus | undefined): IntegrationStatus {
  if (!status) return { tone: "neutral", label: t("dp.state.loading") };
  if (status.recoveryRequired) return { tone: "warn", label: t("dp.state.recovery") };
  if (!status.installed) return { tone: "neutral", label: t("dp.state.notInstalled") };
  if (!status.activated) return { tone: "info", label: t("dp.state.installed") };
  return { tone: "ok", label: t("dp.state.connected") };
}

/** The one line under the title of the screen. */
export function statusLine(status: DpStatus | undefined): { tone: Tone; text: string } {
  if (!status) return { tone: "neutral", text: t("dp.state.loading") };
  if (status.recoveryRequired) return { tone: "warn", text: t("dp.line.recovery") };
  if (!status.installed) return { tone: "neutral", text: t("dp.line.notInstalled") };
  if (!status.activated) return { tone: "neutral", text: t("dp.line.notActivated") };
  return { tone: "ok", text: status.endpointHost ? t("dp.line.connected", { host: status.endpointHost }) : t("dp.line.activated") };
}

export type StepState = "todo" | "done";

/** Which of the first two steps is done: the engine is there, and it holds its credentials. */
export const stepStates = (status: DpStatus | undefined): { install: StepState; activate: StepState } => ({
  install: status?.installed ? "done" : "todo",
  activate: status?.activated ? "done" : "todo",
});

export const VERDICT_CHIP: Record<DpVerdict, { tone: Tone; label: () => string }> = {
  pass: { tone: "ok", label: () => t("dp.verdict.pass") },
  warn: { tone: "warn", label: () => t("dp.verdict.warn") },
  fail: { tone: "danger", label: () => t("dp.verdict.fail") },
  error: { tone: "danger", label: () => t("dp.verdict.error") },
};

/** The server of the MCP list that is DeepPattern: by its name or by the installer's launcher it runs. */
export function findMcpServer(servers: readonly McpServerView[]): McpServerView | undefined {
  const looks = (s: McpServerView) => /deeppattern|decision[-_ ]?engine|installer\.launcher/i.test([s.name, s.command ?? "", ...s.args].join(" "));
  return servers.find(looks);
}

export type McpPresence = "missing" | "needsConfirm" | "off" | "on";

export function mcpPresence(server: McpServerView | undefined): McpPresence {
  if (!server) return "missing";
  if (!server.confirmed) return "needsConfirm";
  return server.enabled ? "on" : "off";
}

/** What "Audit my changes" asks the agent to do. English: the agent answers in the language of the person. */
export const AUDIT_PROMPT = [
  "Use the DeepPattern Decision Engine tools (its MCP server) to get a second opinion on the uncommitted changes of the repositories in this run.",
  "Read them with `git status --porcelain` and `git diff HEAD` (staged and unstaged), and read the new untracked files that are part of the change.",
  "Leave out secrets and noise before anything goes to DeepPattern, which is a hosted service: never send .env files, keys, certificates, credentials, tokens, lock files or generated files, not even a part of them.",
  "Send the diff and a short description of what the change is meant to do for a standard review.",
  "Report what the reviewers found as defects (with file and line), strengths, where they agree and where they disagree, and what you would do next.",
  "Do not edit, stage or commit anything.",
].join("\n");
