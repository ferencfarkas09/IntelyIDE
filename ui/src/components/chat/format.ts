import type { AgentEvent, AgentSummary, Cap, CapEntry, EnforcementTier, ErrorClass, PermissionMode, ToolClass, UsageRecord } from "../../store/agent-types";
import type { Throttle } from "../../store/agent-reducer";
import type { Tone } from "../../ui-kit";
import { t } from "../../i18n";
import { lazyLabels } from "../lazyLabels";

/** `claude-sonnet-5-5` -> `Sonnet 5.5`, `claude-haiku-4-5-20251001` -> `Haiku 4.5`; unknown ids pass through. */
export function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : id;
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return t("chat.unit.ms", { n: Math.round(ms) });
  const s = ms / 1000;
  return s < 60 ? t("chat.unit.s", { n: s.toFixed(s < 10 ? 1 : 0) }) : t("chat.unit.minS", { min: Math.floor(s / 60), s: Math.round(s % 60) });
}

export function fmtCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return t("chat.unit.s", { n: s });
  const min = Math.ceil(s / 60);
  return min < 60 ? t("chat.unit.min", { n: min }) : t("chat.unit.hMin", { h: Math.floor(min / 60), min: min % 60 });
}

/** The five run modes in the user's words (Plan, Ask, Accept edits, Automatic, Bypass); the one table every chip, menu and fact reads. */
export const PERMISSION_LABEL = lazyLabels<PermissionMode>({ readOnly: "modes.readOnly.label", ask: "modes.ask.label", edit: "modes.edit.label", automatic: "modes.automatic.label", bypass: "modes.bypass.label" });

/** What the run header shows for cost; honest about what is an estimate and what is unknown (providers-plan 4.5). */
export function costLabel(usage: UsageRecord | null | undefined, cost: CapEntry): { text: string; title: string } {
  if (cost.cap === "no") return { text: t("chat.cost.na"), title: cost.note ?? t("chat.cost.noCost") };
  // Before the first usage event only a provider that reports cost may say $0.00; others say n/a, never a made-up zero.
  if (!usage) return cost.cap === "yes" ? { text: "$0.00", title: t("chat.cost.noUsage") } : { text: t("chat.cost.na"), title: cost.note ?? t("chat.cost.noUsage") };
  const usd = usage.cumulative.costUsd ?? undefined;
  const amount = usd === undefined ? undefined : usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
  const shown = amount ?? t("chat.na");
  switch (usage.costBasis) {
    case "billed":
      return { text: shown, title: t("chat.cost.billed") };
    case "estimated":
      return { text: t("chat.cost.est", { amount: shown }), title: t("chat.cost.estTip") };
    case "subscription":
      return { text: t("chat.cost.sub", { amount: shown }), title: t("chat.cost.subTip") };
    case "included":
      return { text: t("chat.cost.included"), title: t("chat.cost.includedTip") };
    default:
      return { text: t("chat.cost.na"), title: t("chat.cost.unknownTip") };
  }
}

export const TIER_TONE: Record<EnforcementTier, Tone> = { structural: "ok", strong: "ok", bestEffort: "warn", weak: "danger" };
export const TIER_LABEL = lazyLabels<EnforcementTier>({ structural: "chat.tier.structural", strong: "chat.tier.strong", bestEffort: "chat.tier.bestEffort", weak: "chat.tier.weak" });
export const TIER_TITLE = lazyLabels<EnforcementTier>({
  structural: "chat.tierTitle.structural",
  strong: "chat.tierTitle.strong",
  bestEffort: "chat.tierTitle.bestEffort",
  weak: "chat.tierTitle.weak",
});

export interface EffortChip {
  text: string;
  tone: Tone;
  title: string;
}

/** Effort chip: `n/a` when the model has no control, a "may not apply" badge on partial support, amber on a mismatch. */
export function effortChip(summary: Pick<AgentSummary, "caps" | "requested" | "effective" | "model">): EffortChip {
  const cap: Cap = summary.caps.effort.cap;
  if (cap === "no") return { text: t("chat.na"), tone: "neutral", title: summary.caps.effort.note ?? t("chat.effort.none", { model: modelLabel(summary.model) }) };
  const wanted = summary.requested.effort;
  const got = summary.effective?.effort;
  if (summary.effective && wanted && got !== wanted) return { text: got ?? t("chat.default"), tone: "warn", title: t("chat.effort.mismatch", { wanted, got: got ?? t("chat.effort.providerDefault") }) };
  const text = got ?? wanted ?? t("chat.default");
  return cap === "partial" ? { text, tone: "info", title: t("chat.effort.partial", { note: summary.caps.effort.note ?? t("chat.effort.mayNotApply") }) } : { text, tone: "neutral", title: t("chat.effort.is", { text }) };
}

export const RISK: Record<ToolClass, { label: string; tone: Tone }> = {
  exec: { get label() { return t("chat.risk.exec"); }, tone: "warn" },
  write: { get label() { return t("chat.risk.write"); }, tone: "warn" },
  net: { get label() { return t("chat.risk.net"); }, tone: "info" },
  mcp: { get label() { return t("chat.risk.mcp"); }, tone: "info" },
  read: { get label() { return t("chat.risk.read"); }, tone: "neutral" },
  other: { get label() { return t("chat.risk.other"); }, tone: "warn" },
};

export function errorWording(cls: ErrorClass, message: string): { title: string; hint: string } {
  switch (cls) {
    case "auth":
      return { title: t("chat.error.auth"), hint: t("chat.error.authHint") };
    case "rate":
      return { title: t("chat.error.rate"), hint: t("chat.error.rateHint") };
    case "network":
      return { title: t("chat.error.network"), hint: message };
    case "protocol":
      return { title: t("chat.error.protocol"), hint: message };
    case "provider":
      return { title: t("chat.error.provider"), hint: message };
    case "policy":
      return { title: t("chat.error.policy"), hint: message };
    default:
      return { title: t("chat.error.internal"), hint: message };
  }
}

export function throttleWording(th: Throttle, now: number): { title: string; hint: string } {
  const left = th.retryAfterMs === undefined ? undefined : th.since + th.retryAfterMs - now;
  if (th.state === "retrying") {
    return {
      title: th.scope ? t("chat.throttle.retryingScope", { scope: th.scope }) : t("chat.throttle.retrying"),
      hint: left === undefined ? t("chat.throttle.retryHint") : left > 0 ? t("chat.throttle.retryIn", { time: fmtCountdown(left) }) : t("chat.throttle.retryNow"),
    };
  }
  return {
    title: th.scope ? t("chat.throttle.throttledScope", { scope: th.scope }) : t("chat.throttle.throttled"),
    hint: left === undefined ? t("chat.throttle.slowHint") : left > 0 ? t("chat.throttle.resumeIn", { time: fmtCountdown(left) }) : t("chat.throttle.retryNow"),
  };
}

/** What a screen reader hears for the few events worth interrupting for; the streaming transcript itself stays silent. */
export function announcement(ev: AgentEvent): string | undefined {
  switch (ev.kind) {
    case "permission.request":
      return t("chat.announce.permission", { summary: ev.intent.summary.replace(/`/g, "") });
    case "question.request":
      return t("chat.announce.question", { prompt: ev.prompt });
    case "error":
      return t("chat.announce.error", { title: errorWording(ev.class, ev.message).title });
    case "turn.end":
      return ev.stopReason === "endTurn" ? t("chat.announce.finished") : t("chat.announce.stopped");
    case "status":
      return ev.state === "throttled" ? t("chat.announce.throttled") : undefined;
    case "note":
      // typing a note is the user's own action; what comes of it is worth hearing
      return ev.state === "delivered" ? t("notes.announce.delivered") : ev.state === "dropped" ? t("notes.announce.dropped") : undefined;
    case "session.info":
      // A change of the run's mode (a switch, an approved plan, a resume) is worth hearing; every other session.info is silent.
      return ev.effective?.permission ? t("modes.switch.done", { mode: PERMISSION_LABEL[ev.effective.permission] }) : undefined;
    default:
      return undefined;
  }
}

/** The role an `Agent` / `Task` call starts (`subagent_type` of its input), or undefined for any other call. */
export function subagentRole(name: string, input: unknown): string | undefined {
  if ((name !== "Agent" && name !== "Task") || typeof input !== "object" || input === null) return undefined;
  const v = (input as Record<string, unknown>).subagent_type;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Who made a call when a delegate did (`intent.actor`, set by the sidecar from the harness, never from the model). */
export function intentActor(intent: unknown): { agentId: string; role: string } | undefined {
  const a = (intent as { actor?: { agentId?: unknown; role?: unknown } | null } | null)?.actor;
  return a && typeof a.role === "string" ? { agentId: String(a.agentId ?? ""), role: a.role } : undefined;
}

/** One line for a tool call's header, from the tool name and its (already redacted) input. */
export function toolSummary(name: string, input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const o = input as Record<string, unknown>;
  const pick = (...keys: string[]) => keys.map((k) => o[k]).find((v): v is string => typeof v === "string" && v.length > 0);
  switch (name) {
    case "Bash":
      return pick("command");
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return pick("file_path", "notebook_path", "path");
    case "Grep":
    case "Glob":
      return pick("pattern");
    case "WebFetch":
      return pick("url");
    case "WebSearch":
      return pick("query");
    case "Task":
    case "Agent":
      return pick("description", "subagent_type");
    default:
      return pick("file_path", "path", "command", "pattern", "url", "query", "description");
  }
}

/**
 * One line naming what a permission request would do. For a shell call it is the real command (first line), not the
 * description the model wrote for it, which the model or an injected prompt controls.
 */
export function intentHeadline(intent: { rawCommand?: string | null; summary: string }, max = 120): string {
  const command = intent.rawCommand?.trim();
  const text = command ? command.split("\n")[0] + (command.includes("\n") ? " …" : "") : intent.summary.replace(/`/g, "");
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
