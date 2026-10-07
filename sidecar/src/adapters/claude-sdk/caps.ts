// ProviderCaps computed from initializationResult() + get_settings (providers-plan 1.4, 5.8): nothing is special-cased
// per model; "effort n/a" for Haiku falls out of supportsEffort/supportedEffortLevels.
import type { CapEntry, ModelInfo, ProviderCaps } from '../../types.js';
import type { CliModel } from './facts.js';

const yes = (note?: string): CapEntry => ({ cap: 'yes', ...(note ? { note } : {}) });

export function staticCaps(): ProviderCaps {
  return {
    streaming: yes(),
    toolEvents: yes(),
    permissions: yes('hook + canUseTool'),
    resume: yes(),
    fork: yes(),
    modelList: yes(),
    effort: { cap: 'partial', note: 'depends on the model; refined at session start' },
    effortLevels: [],
    subagents: yes(),
    usage: yes('client estimate, not billed'),
    hooks: yes(),
    modelSwitch: yes(),
    cancel: yes(),
    sandbox: { cap: 'partial', note: 'did not hold under bypass in Phase 0; not counted as a layer' },
    attachments: 'files',
    notes: true,
  };
}

export function capsFor(entry: CliModel | undefined): ProviderCaps {
  const levels = entry?.supportedEffortLevels ?? [];
  const base = staticCaps();
  return {
    ...base,
    effort: entry?.supportsEffort && levels.length ? yes() : { cap: 'no', note: `${entry?.displayName ?? 'this model'} has no effort control` },
    effortLevels: entry?.supportsEffort ? levels : [],
  };
}

export function toModelInfo(m: CliModel & { description?: string }): ModelInfo {
  return { id: m.value, label: m.displayName ?? m.value, effortLevels: m.supportsEffort ? (m.supportedEffortLevels ?? []) : [] };
}
