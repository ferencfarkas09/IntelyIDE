// ProviderCaps computed from the initialize result and the session's config options (providers-plan 1.4, 3.4): runtime truth beats
// the static table. Effort comes from the `thought_level` category, the model list from the `model` category; nothing is special-cased
// per agent.
import type { CapEntry, ModelInfo, ProviderCaps } from '../../types.js';

type Raw = Record<string, any>;

export interface ConfigChoice { value: string; name: string; description?: string }
export interface ConfigSelect { id: string; name: string; category: string | null; current: string; choices: ConfigChoice[] }

export interface ConfigView {
  model?: ConfigSelect;
  thought?: ConfigSelect;
  mode?: ConfigSelect;
  /** Legacy `modes` state of session/new, used when there is no `mode` config option. */
  legacyModes?: { current: string; available: Array<{ id: string; name: string }> };
}

const yes = (note?: string): CapEntry => ({ cap: 'yes', ...(note ? { note } : {}) });
const partial = (note: string): CapEntry => ({ cap: 'partial', note });
const no = (note?: string): CapEntry => ({ cap: 'no', ...(note ? { note } : {}) });

/** Select-type config options by category (the id is a fallback for agents that leave the category out). */
export function configView(options: Raw[] | null | undefined, modes?: Raw | null): ConfigView {
  const view: ConfigView = {};
  for (const o of options ?? []) {
    if (!o || o.type === 'boolean' || !Array.isArray(o.options)) continue;
    const choices: ConfigChoice[] = [];
    for (const c of o.options) {
      if (Array.isArray(c?.options)) for (const g of c.options) choices.push({ value: String(g.value), name: String(g.name ?? g.value), ...(g.description ? { description: String(g.description) } : {}) });
      else if (c && 'value' in c) choices.push({ value: String(c.value), name: String(c.name ?? c.value), ...(c.description ? { description: String(c.description) } : {}) });
    }
    const sel: ConfigSelect = { id: String(o.id), name: String(o.name ?? o.id), category: typeof o.category === 'string' ? o.category : null, current: String(o.currentValue ?? ''), choices };
    const slot = sel.category === 'model' || (!sel.category && sel.id === 'model') ? 'model'
      : sel.category === 'thought_level' ? 'thought'
      : sel.category === 'mode' || (!sel.category && sel.id === 'mode') ? 'mode' : null;
    if (slot && !view[slot]) view[slot] = sel;
  }
  if (!view.mode && modes && Array.isArray(modes.availableModes)) {
    view.legacyModes = { current: String(modes.currentModeId ?? ''), available: modes.availableModes.map((m: Raw) => ({ id: String(m.id), name: String(m.name ?? m.id) })) };
  }
  return view;
}

export function modelsOf(view: ConfigView): ModelInfo[] {
  const levels = view.thought?.choices.map((c) => c.value) ?? [];
  return (view.model?.choices ?? []).map((c) => ({ id: c.value, label: c.name, effortLevels: levels }));
}

/** Everything known before a session exists (initialize alone) or without an agent at all (the static table). */
export function computeCaps(init: Raw | undefined, view: ConfigView = {}): ProviderCaps {
  const ac: Raw = init?.agentCapabilities ?? {};
  const sc: Raw = ac.sessionCapabilities ?? {};
  const known = !!init;
  const canResume = !!ac.loadSession || !!sc.resume;
  const levels = view.thought?.choices.map((c) => c.value) ?? [];
  return {
    streaming: yes(),
    toolEvents: yes(),
    permissions: partial('the agent decides what it asks; our fs and terminal handlers always ask the broker'),
    resume: known ? (canResume ? yes(ac.loadSession ? 'session/load' : 'session/resume') : no('the agent offers neither session/load nor session/resume')) : partial('depends on the agent'),
    fork: sc.fork ? partial('unstable in ACP') : no(),
    modelList: view.model ? yes('config option') : known ? no('the agent exposes no model option') : partial('read from the agent at session start'),
    effort: view.thought ? yes('thought_level') : known ? no('the agent exposes no thinking-level option') : partial('read from the agent at session start'),
    effortLevels: levels,
    subagents: no(),
    usage: partial('context window and per-turn tokens; no cost unless the agent reports one'),
    hooks: no('not available over ACP'),
    modelSwitch: view.model ? partial('session/set_config_option; support varies by agent') : no(),
    cancel: yes('session/cancel; escalates to SIGTERM and SIGKILL when ignored'),
    sandbox: no('not counted until an attempt suite proves it'),
    attachments: ac.promptCapabilities?.image ? 'images' : 'none',
  };
}
