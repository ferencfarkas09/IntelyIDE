// "Fix with agent" / "Explain this error": the buttons in the terminal, the Run panel's log, the failed pre-commit checks and
// the component preview, and a palette command for the terminal. The helper itself is `platform/sendToAgent.ts`, so other
// modules (a React Native red screen) can use it. A lazy extra that starts switched on, with a Settings toggle.
import { createEffect, createRoot, lazy } from "solid-js";
import { t } from "../../i18n";
import { registerCommand } from "../../platform/commands";
import { registerSettingsSection } from "../../platform/settings";
import { sendErrorToAgent } from "../../platform/sendToAgent";
import { Sparkles, toast } from "../../ui-kit";
import { sendToAgentEnabled } from "./toggle";

let live: (() => void)[] = [];

async function fromTerminal(intent: "fix" | "explain"): Promise<void> {
  const input = (await import("../terminal/store")).terminalErrorInput();
  if (!input || !input.text.trim()) return void toast.info(t("toAgent.nothing"), t("toAgent.nothingBody"));
  if (!(await sendErrorToAgent({ ...input, intent }))) toast.warn(t("toAgent.noDialog"));
}

function activate(): void {
  if (live.length) return;
  live = [
    registerCommand({ id: "toAgent.terminalFix", get title() { return t("toAgent.cmd.terminalFix"); }, get group() { return t("toAgent.name"); }, keywords: ["error", "fix", "agent", "terminal", "stack trace", "failed"], run: () => void fromTerminal("fix") }),
    registerCommand({ id: "toAgent.terminalExplain", get title() { return t("toAgent.cmd.terminalExplain"); }, get group() { return t("toAgent.name"); }, keywords: ["error", "explain", "agent", "terminal"], run: () => void fromTerminal("explain") }),
  ];
}

function deactivate(): void {
  for (const off of live) off();
  live = [];
}

export function register(): void {
  registerSettingsSection({ id: "sendtoagent", get title() { return t("toAgent.section.name"); }, order: 108, icon: Sparkles, searchTerms: ["error", "fix", "agent", "explain", "terminal", "log"], component: lazy(() => import("./SendSection")) });
  createRoot(() => createEffect(() => (sendToAgentEnabled() ? activate() : deactivate())));
}
