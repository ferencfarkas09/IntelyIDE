// What a refused tool call tells the person: the IDE's own reason, which the tool result carries back to the model, split from the
// CLI's hook-error framing and from the trailing `(decided by, rule)` tag, and a one-line headline for the rules that come up most.
import { t, type MessageKey } from "../../i18n";

export interface Refusal {
  /** The IDE's reason as the model read it. */
  reason: string;
  /** The rule that decided, `exec.auto.outside-jail`, `git.commit`, `role.read-only`, `cli.prompt-denied` ... */
  rule?: string;
}

/**
 * `PreToolUse:Bash hook error: INTELY-HARDSTOP: <reason> (<by>, <rule>)` or `INTELY-HARDSTOP: <reason> (<by>, <rule>)`.
 * `undefined` for any other output (an ordinary tool error is not a refusal).
 */
export function refusalOf(output: string | null | undefined): Refusal | undefined {
  const m = /INTELY-HARDSTOP:\s*([\s\S]*)$/.exec(output ?? "");
  if (!m) return undefined;
  let reason = m[1].trim();
  let rule: string | undefined;
  const tag = /\s*\(([a-zA-Z]+),\s*([A-Za-z0-9._-]+)\)\s*$/.exec(reason);
  if (tag) {
    rule = tag[2];
    reason = reason.slice(0, tag.index).trim();
  }
  return reason ? { reason, ...(rule ? { rule } : {}) } : undefined;
}

/** The rules whose cause the model or the person can name in a few words. The rest show the first sentence of the reason. */
const HEADLINES: ReadonlyArray<[prefix: string, key: MessageKey]> = [
  ["exec.auto.outside-jail", "chat.refusal.outsideJail"],
  ["exec.auto.unjudgeable", "chat.refusal.unjudgeable"],
  ["exec.auto.inline-code", "chat.refusal.inlineCode"],
  ["exec.auto.network", "chat.refusal.network"],
  ["exec.auto.env-override", "chat.refusal.envOverride"],
  ["exec.auto.destructive", "chat.refusal.destructive"],
  ["exec.auto.script-risk", "chat.refusal.scriptRisk"],
  ["read.auto.", "chat.refusal.outsideJail"],
  ["write.auto.", "chat.refusal.outsideJail"],
  ["cli.prompt-denied", "chat.refusal.cliPrompt"],
  ["role.read-only", "chat.refusal.readOnly"],
  ["role.", "chat.refusal.notThisRole"],
  ["git.", "chat.refusal.humanOnly"],
];

/** Whether the rule belongs to the role (what the role may use) rather than to how the run judges a command. */
export const isRoleRule = (rule: string | undefined): boolean => !!rule && (rule.startsWith("role.") || rule.startsWith("delegate.") || rule.startsWith("mcp."));

/** One line for the transcript: a headline for the common rules, else the first sentence of the reason. */
export function refusalHeadline(r: Refusal): string {
  const hit = r.rule ? HEADLINES.find(([prefix]) => r.rule!.startsWith(prefix)) : undefined;
  if (hit) return t(hit[1]);
  const first = r.reason.split(/(?<=[.;])\s/)[0] ?? r.reason;
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

/** The CLI's own safety prompt the IDE could not answer: `The Claude CLI raised its own safety prompt (<reason>); the IDE does not answer those in <Mode> on its own.` */
const CLI_PROMPT = /^The Claude CLI raised its own safety prompt \((.+?)\); the IDE does not answer those in (\w+) on its own\./;

/** The localized sentence for that message, or `undefined` when the message is something else. */
export function cliPromptHint(message: string): string | undefined {
  const m = CLI_PROMPT.exec(message);
  if (!m) return undefined;
  return t("chat.refusal.cliPromptHint", { reason: m[1], mode: m[2] });
}
