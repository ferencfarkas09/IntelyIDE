import { t, type MessageKey } from "../../i18n";
import type { Tone } from "../../ui-kit";
import type { CiState, PrCheck, ReviewState } from "./types";

/** The typed confirmation: the exact text, no trimming, case matters. */
export const confirmed = (typed: string, expected: string): boolean => expected !== "" && typed === expected;

export const ciTone = (s: CiState): Tone => (s === "passing" ? "ok" : s === "failing" ? "danger" : s === "pending" ? "warn" : "neutral");
export const reviewTone = (s: ReviewState): Tone => (s === "approved" ? "ok" : s === "changesRequested" ? "danger" : s === "reviewRequired" ? "warn" : "neutral");
export const bucketTone = (b: PrCheck["bucket"]): Tone => (b === "pass" ? "ok" : b === "fail" || b === "cancel" ? "danger" : b === "pending" ? "warn" : "neutral");

/** Only an https link may be handed to the system browser. */
export const isHttps = (url: string | null | undefined): url is string => {
  if (!url) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
};

const KNOWN = new Set(["readOnly", "testJail", "noUpstream", "upstreamMismatch", "liveHead", "detachedHead", "noBase", "unknownBase", "sameBranch", "nothingAhead", "confirmRequired", "emptyTitle", "ghMissing", "ghAuth"]);

/** A translated reason for an engine error or a plan refusal; unknown codes fall back to the engine's own text. */
export function reasonText(e: { code?: string; message?: string } | unknown): string {
  const err = (e && typeof e === "object" ? e : {}) as { code?: string; message?: string };
  if (err.code && KNOWN.has(err.code)) return t(`pr.err.${err.code}` as MessageKey);
  return err.message ?? String(e);
}

/** The jail codes that switch the tab to its read-only notice. */
export const isJail = (code: string | null | undefined): boolean => code === "readOnly" || code === "testJail";
