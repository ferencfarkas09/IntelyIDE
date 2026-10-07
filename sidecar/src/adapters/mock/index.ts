// Mock provider: scripted JSONL scenarios with timing, same interface as the real adapters (providers-plan 5.8).
import type { AgentProvider } from '../../types.js';
import { MockSession } from './session.js';
import { SCENARIOS } from './scenarios.js';

const provider: AgentProvider = {
  id: 'mock',
  kind: 'cli',
  detect: async () => ({ installed: true, version: 'mock', auth: 'ok' }),
  capabilities: () => {
    const yes = { cap: 'yes' as const };
    return {
      streaming: yes, toolEvents: yes, permissions: yes, resume: yes, fork: { cap: 'no', note: 'scripted' }, modelList: yes,
      effort: { cap: 'no', note: 'mock' }, effortLevels: [], subagents: yes, usage: yes, hooks: { cap: 'no' }, modelSwitch: { cap: 'no' }, cancel: yes,
      sandbox: { cap: 'no' }, attachments: 'files', notes: true,
    };
  },
  listModels: async () => [{ id: 'mock-1', label: 'Mock (scripted)', effortLevels: [] }],
  open: async (spec, sink, policy) => {
    const m = spec.mock ?? {};
    const text = m.script ?? SCENARIOS[m.scenario ?? 'plain-reply'];
    if (!text) throw new Error(`unknown mock scenario "${m.scenario}" (have: ${Object.keys(SCENARIOS).join(', ')})`);
    return new MockSession(spec, sink, text, policy);
  },
};

export default provider;
