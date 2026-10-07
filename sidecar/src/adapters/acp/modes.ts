// Agent mode / model / thinking-level words -> the abstract vocabulary of the roles (providers-plan 2.2). Pure.
import type { PermissionMode } from '../../types.js';
import type { ConfigChoice, ConfigView } from './caps.js';

/** Modes that approve everything on their own: never accepted for a role below `auto`, and `auto` is never offered. */
const UNSAFE = /yolo|bypass|dont.?ask|danger|full.?access|auto.?approve|accept.?all|never.?ask/i;
const READ_ONLY = /^(plan|read.?only|readonly|research|ask.?only|view)$|plan/i;
const EDIT = /accept.?edits?|auto.?edit|edit/i;
const ASK = /^(default|ask|normal|manual|review)$/i;

export const isUnsafeMode = (id: string): boolean => UNSAFE.test(id);

/** The abstract mode an agent mode id stands for; unknown words are treated as `ask`, the middle of the ladder. */
export function abstractMode(id: string): PermissionMode {
  if (UNSAFE.test(id)) return 'bypass';
  if (READ_ONLY.test(id)) return 'readOnly';
  if (EDIT.test(id)) return 'edit';
  return 'ask';
}

export interface ModeChoice { id: string; name: string }

export function modeChoices(view: ConfigView): ModeChoice[] {
  if (view.mode) return view.mode.choices.map((c) => ({ id: c.value, name: c.name }));
  return view.legacyModes?.available ?? [];
}

export const currentMode = (view: ConfigView): string | undefined => view.mode?.current ?? view.legacyModes?.current;

/** The agent mode that realises a role's abstract permission, or undefined when the agent has none. Never an unsafe one. */
export function modeFor(permission: PermissionMode, view: ConfigView): string | undefined {
  const safe = modeChoices(view).filter((m) => !isUnsafeMode(m.id) && !isUnsafeMode(m.name));
  const by = (re: RegExp) => safe.find((m) => re.test(m.id))?.id ?? safe.find((m) => re.test(m.name))?.id;
  switch (permission) {
    case 'readOnly': return by(READ_ONLY);
    case 'edit': return by(EDIT);
    case 'ask': return by(ASK);
    default: return undefined;
  }
}

/** A value of a select option that matches the wanted word (exact id, then name, case-insensitive). */
export function pick(choices: ConfigChoice[], want: string | null | undefined): string | undefined {
  if (!want) return undefined;
  const w = want.toLowerCase();
  return choices.find((c) => c.value.toLowerCase() === w)?.value ?? choices.find((c) => c.name.toLowerCase() === w)?.value;
}

/** Effort: the role's abstract level against the agent's own level names; `xhigh`/`max` clamp to the top, `low` to the bottom. */
export function pickEffort(choices: ConfigChoice[], want: string | null | undefined): { value?: string; clamped?: boolean } {
  const exact = pick(choices, want);
  if (exact) return { value: exact };
  if (!want || !choices.length) return {};
  if (want === 'xhigh' || want === 'max') return { value: choices[choices.length - 1]!.value, clamped: true };
  if (want === 'low') return { value: choices[0]!.value, clamped: true };
  if (want === 'medium') return { value: choices[Math.floor((choices.length - 1) / 2)]!.value, clamped: true };
  if (want === 'high') return { value: choices[Math.max(0, choices.length - 2)]!.value, clamped: true };
  return {};
}
