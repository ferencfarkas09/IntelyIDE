import type { Effort } from "@intely/protocol";
import type { RoleProviderCaps } from "../../ipc/roles";
import { clampEffort, EFFORT_LADDER } from "../roles/rolesLogic";

/** What the picker chose for one run. Absent fields mean "the role's own" (or Auto's), and nothing of them is sent. */
export interface RunPick {
  model?: string;
  effort?: Effort;
  ultracode?: boolean;
}

/** The select value of "Other model id...": never a model id (ids have no spaces). */
export const OTHER_MODEL = "other model";

/** A model id the user may type: a Claude id (`claude-...`), with what the host accepts after it (`[1m]`, `@date`, `:0`). */
export const isClaudeModelId = (id: string): boolean => id.length <= 128 && /^claude-[a-z0-9][a-z0-9._:@/[\]-]*$/i.test(id);

export interface ModelChoice {
  id: string;
  label: string;
  /** Empty: the model has no effort control. */
  effortLevels: readonly Effort[];
}

/** Every model the provider reports (the live list for Claude, else the provider's caps), in its order. */
export const modelChoices = (caps: readonly RoleProviderCaps[], provider: string): ModelChoice[] => caps.find((c) => c.provider === provider)?.models ?? [];

export interface EffortChoice {
  /** The levels to offer; empty = the model has no effort control (the select is disabled). */
  levels: readonly Effort[];
  /** The model is not in the list: the whole ladder is offered and the model takes what it supports (Claude only). */
  unknownModel: boolean;
}

/**
 * The effort levels for a model: the ones it reports, in ladder order. A Claude model the list does not know (a typed id, a newer model)
 * gets the whole ladder; another provider's unknown model gets none (its caps are all there is to go by).
 */
export function effortChoice(model: string | undefined, caps: readonly RoleProviderCaps[], provider: string): EffortChoice {
  const known = model === undefined ? undefined : modelChoices(caps, provider).find((m) => m.id === model);
  if (known) return { levels: EFFORT_LADDER.filter((l) => known.effortLevels.includes(l)), unknownModel: false };
  if (provider === "claude" && model) return { levels: EFFORT_LADDER, unknownModel: true };
  return { levels: [], unknownModel: false };
}

/**
 * After the model changed: the picked effort snapped into what the new model takes (the nearest level that is not higher), none when it has
 * no effort control. An effort that was never picked stays unpicked (the role's own applies).
 */
export function effortAfterModelChange(effort: Effort | undefined, levels: readonly Effort[]): Effort | undefined {
  if (effort === undefined) return undefined;
  return clampEffort(effort, levels) ?? undefined;
}

/**
 * The fields of the start request: only what was picked, so an untouched picker sends exactly what a run sent before it existed. An effort
 * the run's model does not take (`effortLevels`, see `effortChoice`) is not sent.
 */
export function pickRequest(pick: RunPick, opts: { ultracodeAllowed: boolean; effortLevels: readonly Effort[] }): RunPick {
  const model = pick.model?.trim();
  return {
    ...(model ? { model } : {}),
    ...(pick.effort && opts.effortLevels.includes(pick.effort) ? { effort: pick.effort } : {}),
    ...(pick.ultracode && opts.ultracodeAllowed ? { ultracode: true } : {}),
  };
}

/** Why the picker blocks Start: a model that is neither in the provider's list nor a Claude id someone typed (an empty "Other" included). */
export function pickBlocker(pick: RunPick, caps: readonly RoleProviderCaps[], provider: string): "badModel" | undefined {
  if (pick.model === undefined) return undefined;
  const model = pick.model.trim();
  if (modelChoices(caps, provider).some((m) => m.id === model)) return undefined;
  return provider === "claude" && isClaudeModelId(model) ? undefined : "badModel";
}

/** Ultracode is offered for a Claude run of one role: Auto already hands work to the roles, other providers have no Workflow tool. */
export const ultracodeOffered = (provider: string, auto: boolean): boolean => provider === "claude" && !auto;

/** The remembered choice (settings `runs.lastModel` / `runs.lastEffort`) as a pick, kept only where it still fits this provider's list. */
export function restoredPick(saved: { lastModel?: unknown; lastEffort?: unknown }, caps: readonly RoleProviderCaps[], provider: string): RunPick {
  const model = typeof saved.lastModel === "string" && saved.lastModel ? saved.lastModel : undefined;
  const listed = model !== undefined && modelChoices(caps, provider).some((m) => m.id === model);
  const keepModel = model !== undefined && (listed || (provider === "claude" && isClaudeModelId(model)));
  const effort = typeof saved.lastEffort === "string" && (EFFORT_LADDER as readonly string[]).includes(saved.lastEffort) ? (saved.lastEffort as Effort) : undefined;
  const levels = effortChoice(keepModel ? model : undefined, caps, provider).levels;
  // an effort remembered without a model is kept as it is: the role's model decides at start (an unknown one takes the ladder)
  const keptEffort = effort && keepModel ? effortAfterModelChange(effort, levels) : effort;
  return { ...(keepModel ? { model } : {}), ...(keptEffort ? { effort: keptEffort } : {}) };
}
