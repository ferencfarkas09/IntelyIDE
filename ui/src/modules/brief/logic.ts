// Pure helpers of the night queue and the Morning brief: validation (the same limits as `intely_runindex::night`),
// the message keys of states and reasons, and small formatters.
import type { MessageKey } from "../../i18n";
import type { ItemState, NewItem, NightItem, Paused } from "./types";

export const LIMITS = { minMinutes: 1, maxMinutes: 480, minTokens: 1_000, maxTokens: 5_000_000, defaultMinutes: 30, defaultTokens: 200_000, maxPrompt: 12_000 } as const;

export type FormError = "noRole" | "noRepo" | "emptyPrompt" | "promptTooLong" | "badMinutes" | "badTokens" | "nightCap";

/** The first thing that stops the form from being added, or undefined. */
export function validate(draft: Partial<NewItem>, count: number, cap: number): FormError | undefined {
  if (count >= cap) return "nightCap";
  if (!draft.roleId) return "noRole";
  if (!draft.repoIds?.length) return "noRepo";
  const prompt = (draft.prompt ?? "").trim();
  if (!prompt) return "emptyPrompt";
  if ([...prompt].length > LIMITS.maxPrompt) return "promptTooLong";
  const m = draft.maxMinutes ?? NaN;
  if (!Number.isInteger(m) || m < LIMITS.minMinutes || m > LIMITS.maxMinutes) return "badMinutes";
  const k = draft.maxTokens ?? NaN;
  if (!Number.isInteger(k) || k < LIMITS.minTokens || k > LIMITS.maxTokens) return "badTokens";
  return undefined;
}

export const FORM_ERROR_KEY: Record<FormError, MessageKey> = {
  noRole: "night.err.noRole",
  noRepo: "night.err.noRepo",
  emptyPrompt: "night.err.emptyPrompt",
  promptTooLong: "night.err.promptTooLong",
  badMinutes: "night.err.badMinutes",
  badTokens: "night.err.badTokens",
  nightCap: "night.err.nightCap",
};

export const STATE_KEY: Record<ItemState, MessageKey> = {
  queued: "night.state.queued",
  running: "night.state.running",
  done: "night.state.done",
  failed: "night.state.failed",
  stopped: "night.state.stopped",
  skipped: "night.state.skipped",
};

export const STATE_TONE = { queued: "neutral", running: "info", done: "ok", failed: "danger", stopped: "warn", skipped: "neutral" } as const;

export const PAUSED_KEY: Record<Paused, MessageKey> = { battery: "night.paused.battery", readOnly: "night.paused.readOnly" };

/** The text for why an item ended: a budget, a stop, or an engine code (unknown codes are shown as they are). */
export function reasonKey(reason: string | undefined): MessageKey | undefined {
  switch (reason) {
    case undefined:
      return undefined;
    case "timeBudget":
      return "night.reason.timeBudget";
    case "tokenBudget":
      return "night.reason.tokenBudget";
    case "userStop":
      return "night.reason.userStop";
    case "interrupted":
      return "night.reason.interrupted";
    case "noSafetyNet":
      return "night.reason.noSafetyNet";
    default:
      return undefined;
  }
}

/** Share of the token budget used, 0..100. */
export const tokenPercent = (item: NightItem): number => Math.min(100, Math.round((item.tokensUsed / Math.max(1, item.maxTokens)) * 100));

/** Share of the time budget used while running, 0..100. */
export function timePercent(item: NightItem, nowMs: number): number {
  if (item.startedMs === undefined) return 0;
  const end = item.endedMs ?? nowMs;
  return Math.min(100, Math.round(((end - item.startedMs) / (item.maxMinutes * 60_000)) * 100));
}

export function duration(ms: number): { minutes: number; seconds: number } {
  const total = Math.max(0, Math.round(ms / 1000));
  return { minutes: Math.floor(total / 60), seconds: total % 60 };
}

/** What the brief says first: the runs that need a human, in the order they should be looked at. */
export function needsAttention(run: { status: string; needsYou: unknown[]; failureCount: number }): boolean {
  return run.needsYou.length > 0 || run.status === "failed" || run.failureCount > 0;
}
