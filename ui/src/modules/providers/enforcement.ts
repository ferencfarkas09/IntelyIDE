import type { EnforcementChip, PermissionMode, Suite, SuiteResult, Tier } from "@intely/protocol";
import type { ProviderEnforcement } from "../../ipc/providers";
import { TIER_LABEL, TIER_TONE } from "../../components/chat/format";
import { t, type MessageKey } from "../../i18n";

export { TIER_LABEL, TIER_TONE };

export type RoleKind = "readOnly" | "write";
/** Every mode but read-only can change files or run commands, so it is judged by the write results. */
export const roleKind = (mode: PermissionMode): RoleKind => (mode === "readOnly" ? "readOnly" : "write");

export const TIER_RANK: Record<Tier, number> = { weak: 0, bestEffort: 1, strong: 2, structural: 3 };

/** A provider other than Claude may run roles that change files only at this tier or above ((design notes: providers-plan) 3.1). */
export const WRITE_MIN_TIER: Tier = "strong";

export const SUITES: readonly Suite[] = ["t0", "s0", "s1", "s2", "s3", "s4"];
export const suiteLabel = (suite: Suite): string => t(`providers.suite.${suite}` as MessageKey);

export const weakExplanation = (): string => t("providers.enf.weak");

export interface ShownTier {
  tier: Tier;
  /** Suites with a recorded result, in suite order. */
  results: { suite: Suite; result: SuiteResult }[];
  passed: Suite[];
  /** The backend sent a tier above weak without a passing suite behind it; it is shown as weak. */
  downgraded: boolean;
}

/** The chip as the UI shows it: a tier counts only when a recorded run with at least one passing suite stands behind it. */
export function shownTier(chip: EnforcementChip | null | undefined): ShownTier {
  const suites = chip?.run?.suites ?? {};
  const results = SUITES.flatMap((suite) => (suites[suite] !== undefined ? [{ suite, result: suites[suite]! }] : []));
  const passed = results.filter((r) => r.result === "pass").map((r) => r.suite);
  const claimed = chip?.tier ?? "weak";
  const proven = chip?.run !== undefined && chip.run !== null && passed.length > 0;
  const downgraded = claimed !== "weak" && !proven;
  return { tier: downgraded ? "weak" : claimed, results, passed, downgraded };
}

export function chipFor(list: readonly ProviderEnforcement[], provider: string, kind: RoleKind): EnforcementChip | undefined {
  return list.find((e) => e.provider === provider && e.roleMode === kind)?.chip;
}

export const tierFor = (list: readonly ProviderEnforcement[], provider: string, kind: RoleKind): ShownTier => shownTier(chipFor(list, provider, kind));

export interface Gate {
  ok: boolean;
  /** Why the combination is refused. */
  reason?: string;
  /** Allowed, but the user should know. */
  caution?: string;
}

/**
 * May a role with this permission mode run on this provider? Read-only always may. A provider other than Claude
 * may change files only at `WRITE_MIN_TIER`, or when the user allowed that provider (`writerAllowed`, Settings > Safety).
 * Claude keeps its alpha behaviour (its hooks are the proven path) and gets a caution instead.
 */
export function roleGate(provider: string, providerName: string, mode: PermissionMode, tier: Tier, writerAllowed = false): Gate {
  if (mode === "readOnly") return { ok: true, ...(tier === "weak" ? { caution: t("providers.gate.weakReadOnly", { name: providerName }) } : {}) };
  if (provider === "claude") {
    return TIER_RANK[tier] < TIER_RANK[WRITE_MIN_TIER] ? { ok: true, caution: t("providers.gate.claudeCaution", { tier: TIER_LABEL[tier] }) } : { ok: true };
  }
  // The scripted provider of the e2e harness: the host exempts it too (`check_provider_gate`), it has no enforcement to prove.
  if (provider === "mock") return { ok: true };
  if (TIER_RANK[tier] >= TIER_RANK[WRITE_MIN_TIER]) return { ok: true };
  // The user's per-provider override (Settings > Safety): allowed, with the honest caution; the tier itself does not change.
  if (writerAllowed) return { ok: true, caution: t("providers.gate.overrideCaution", { name: providerName, tier: TIER_LABEL[tier] }) };
  return { ok: false, reason: t("providers.gate.refused", { name: providerName, tier: TIER_LABEL[tier], min: TIER_LABEL[WRITE_MIN_TIER] }) };
}
