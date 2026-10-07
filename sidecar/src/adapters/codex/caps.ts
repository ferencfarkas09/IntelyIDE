// ProviderCaps for Codex (providers-plan 1.4 matrix column "Codex (app-server)"), refined from model/list at session start.
import type { CapEntry, ModelInfo, ProviderCaps } from '../../types.js';
import { isObj, type Json } from './wire.js';

const yes = (note?: string): CapEntry => ({ cap: 'yes', ...(note ? { note } : {}) });

export function staticCaps(): ProviderCaps {
  return {
    streaming: yes('deltas'),
    toolEvents: yes('items'),
    permissions: yes('requestApproval -> broker; one-shot decisions only'),
    resume: yes('thread/resume'),
    fork: { cap: 'partial', note: 'thread/fork exists; not wired yet' },
    modelList: yes('model/list'),
    effort: { cap: 'partial', note: 'depends on the model; refined at session start' },
    effortLevels: [],
    subagents: { cap: 'no', note: 'multi_agent is disabled for IDE sessions' },
    usage: { cap: 'partial', note: 'tokens only; included in the ChatGPT plan, no cost' },
    hooks: { cap: 'no', note: 'hooks feature disabled; rules files only' },
    modelSwitch: { cap: 'partial', note: 'per turn' },
    cancel: yes('turn/interrupt'),
    sandbox: { cap: 'partial', note: 'Seatbelt profile :workspace keeps .git read-only and network off; not counted as a layer until the suites ran' },
    attachments: 'files',
  };
}

export function toModelInfo(m: Json): ModelInfo {
  const levels = Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts.filter(isObj).map((o) => String(o.reasoningEffort)) : [];
  return { id: String(m.model ?? m.id), label: String(m.displayName ?? m.model ?? m.id), effortLevels: levels };
}

export function capsFor(model: ModelInfo | undefined): ProviderCaps {
  const base = staticCaps();
  const levels = model?.effortLevels ?? [];
  return {
    ...base,
    effort: levels.length ? yes() : { cap: 'no', note: `${model?.label ?? 'this model'} has no effort control` },
    effortLevels: levels,
  };
}

/** model/list response -> visible models. */
export function modelsOf(r: unknown): ModelInfo[] {
  const data: unknown[] = isObj(r) && Array.isArray(r.data) ? r.data : [];
  return data.filter(isObj).filter((m) => !m.hidden).map(toModelInfo);
}
