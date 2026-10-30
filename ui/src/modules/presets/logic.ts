// Safety presets: three plain-language names for the permission modes a vibe coder needs. They only pick an existing mode;
// the policy, the hard stops and the secret rules are the same in every one of them. Plan (read only) and Bypass stay on
// the permission cards: Bypass keeps its typed confirmation.
import type { PermissionMode } from "../../store/agent-types";
import { MODE_ORDER } from "../../store/permissionModes";
import { DEFAULT_MODE_UNTIL_AG1 } from "../runs/newRunLogic";

export type PresetId = "careful" | "balanced" | "autonomous";

export const PRESETS: readonly { id: PresetId; mode: PermissionMode }[] = [
  { id: "careful", mode: "ask" },
  { id: "balanced", mode: "edit" },
  { id: "autonomous", mode: "automatic" },
];

/** The preset a mode belongs to; undefined for Plan and Bypass (picked on the cards). */
export const presetOf = (mode: PermissionMode | undefined): PresetId | undefined => PRESETS.find((p) => p.mode === mode)?.id;
export const modeOf = (id: PresetId): PermissionMode => PRESETS.find((p) => p.id === id)!.mode;

/** Why a preset cannot be picked now: its mode is not offered by the provider, or its gate refuses it. */
export function presetBlocker(id: PresetId, supported: readonly PermissionMode[], unavailable: Partial<Record<PermissionMode, string>>): string | undefined {
  const mode = modeOf(id);
  if (unavailable[mode]) return unavailable[mode];
  if (supported.length && !supported.includes(mode)) return "unsupported";
}

const asMode = (v: unknown): PermissionMode | undefined => (typeof v === "string" && (MODE_ORDER as readonly string[]).includes(v) && v !== "bypass" ? (v as PermissionMode) : undefined);

/**
 * The mode the New Run dialog starts with, from the `runs` settings: the default chosen in Settings > Agents
 * (`defaultMode`) when there is one, else the mode of the last run (`lastMode`). Never Bypass.
 */
export const startMode = (runs: Record<string, unknown>): PermissionMode | undefined => asMode(runs.defaultMode) ?? asMode(runs.lastMode);

/** What a new run really starts with when nothing in the settings says otherwise. */
export const effectiveStartMode = (runs: Record<string, unknown>): PermissionMode => startMode(runs) ?? DEFAULT_MODE_UNTIL_AG1;
