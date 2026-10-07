// Delegation in the Claude adapter, against a fake SDK ((design notes: roles-orchestration-spec) 4.4, 8.3): the `agents` option, the
// SubagentStart/Stop hooks, the fail-closed actor, the canary, the Agent input rewrite, the two-sided init assertion and
// per-model usage. The real CLI behaviour (agent_id delivery, updatedInput) is what the opt-in live smoke proves.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertInit, BUILTIN_AGENT_TYPES } from '../src/adapters/claude-sdk/facts.js';
import { CANARY_MARK, DENY_MARK, rewriteAgentInput } from '../src/adapters/claude-sdk/gate.js';
import { mapRaw, newMapState } from '../src/adapters/claude-sdk/map.js';
import { buildAgents, ClaudeSession, LEAD_HIDDEN_AGENT_TYPES } from '../src/adapters/claude-sdk/session.js';
import { settingsOverlay } from '../src/adapters/claude-sdk/settings.js';
import { SeqSink, TurnGuard } from '../src/turn.js';
import type { DelegateSpec, PolicyClient, PolicyDecision, PolicyRequest, SessionSpec, WireEvent } from '../src/types.js';

// ---------- fake SDK ----------
const fake = vi.hoisted(() => {
  const state: { options: any; interrupts: number; closed: number; queue: any[]; waiter?: () => void; ended: boolean } = { options: undefined, interrupts: 0, closed: 0, queue: [], ended: false };
  return state;
});

vi.mock('../src/sdk.js', () => ({
  loadSdk: async () => ({
    query: ({ options }: { options: any }) => {
      fake.options = options;
      return {
        initializationResult: async () => ({ models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }] }),
        getSettings: async () => ({ applied: { effort: null } }),
        interrupt: async () => { fake.interrupts++; },
        close: () => { fake.closed++; fake.ended = true; fake.waiter?.(); },
        setModel: async () => undefined,
        [Symbol.asyncIterator]() {
          return {
            next: async () => {
              for (;;) {
                if (fake.queue.length) return { value: fake.queue.shift(), done: false };
                if (fake.ended) return { value: undefined, done: true };
                await new Promise<void>((r) => { fake.waiter = r; });
              }
            },
          };
        },
      };
    },
  }),
  SdkError: class extends Error {},
}));

const push = (m: unknown) => { fake.queue.push(m); fake.waiter?.(); };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ---------- fixture: the shared golden cases ----------
type Case = { name: string; delegates: Record<string, unknown> | null; ctx: Record<string, unknown>; actor: { agentId: string; role: string } | null; tool: string; input: unknown; intent: Record<string, unknown>; expected: { decision: PolicyDecision['decision']; by: PolicyDecision['by']; rule: string } };
const cases = (JSON.parse(readFileSync(new URL('../../packages/protocol/fixtures/delegation-cases.json', import.meta.url), 'utf8')) as { cases: Case[] }).cases;
const stripNulls = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, stripNulls(x)]));
  return v;
};
const sortKeys = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
};
// Rust writes [] for absent lists, TypeScript may omit them: both mean the same
const dropEmpty = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(dropEmpty);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => !(Array.isArray(x) && x.length === 0)).map(([k, x]) => [k, dropEmpty(x)]));
  return v;
};
// the summary is display text and differs between the two mappings on purpose (the existing parity test ignores it too)
const key = (intent: unknown) => JSON.stringify(sortKeys(dropEmpty(stripNulls({ ...(intent as object), summary: undefined }))));

/** Answers like the Rust broker did when the fixture was written: finds the golden case whose intent equals the request's. */
function goldenPolicy(seen: PolicyRequest[] = []): PolicyClient {
  return {
    decide: async (req) => {
      seen.push(req);
      const hit = cases.find((c) => key(c.intent) === key(req.intent));
      if (!hit) return { decision: 'deny', by: 'failClosed', reason: 'no golden case for this intent', rule: 'test.no-case' };
      return { decision: hit.expected.decision, by: hit.expected.by, reason: hit.name, rule: hit.expected.rule };
    },
  };
}

// ---------- session rig ----------
const delegate = (over: Partial<DelegateSpec> = {}): DelegateSpec => ({
  name: 'researcher', description: 'Reads code', prompt: 'PREAMBLE\n\nAnswer from the code.', model: 'claude-haiku-4-5-20251001', permission: 'readOnly',
  tools: ['Read', 'Grep', 'Glob'], disallowedTools: ['RemoteTrigger', 'Agent', 'Task'], maxTurns: 25, scope: 'global', ...over,
});
const THREE: DelegateSpec[] = [
  delegate(),
  delegate({ name: 'developer', description: 'Implements', model: 'claude-sonnet-5-5', effort: 'medium', permission: 'edit', tools: [], disallowedTools: ['RemoteTrigger'], maxTurns: 40, scope: 'builtin', color: '#3b82f6' }),
  delegate({ name: 'writer', description: 'Edits files, no shell', permission: 'edit', tools: ['Read', 'Edit', 'Write'], maxTurns: undefined, scope: 'repo' }),
];

function spec(over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    agentId: 'a1', provider: 'claude', role: { name: 'auto', model: 'claude-sonnet-5-5', permission: 'edit', disallowedTools: ['RemoteTrigger'] }, cwd: '/tmp/x', addDirs: [],
    env: { claudeBin: '/bin/claude', shimDir: '/shim' }, mcp: {}, auth: { mode: 'subscription', key: null }, ...over,
  };
}

async function open(over: Partial<SessionSpec> = {}, policy: PolicyClient = goldenPolicy()) {
  const out: WireEvent[] = [];
  const guard = new TurnGuard(new SeqSink((e) => out.push(e)));
  guard.beginTurn();
  const s = await ClaudeSession.open(spec(over), guard, policy, { registerPid: () => undefined });
  const hooks = fake.options.hooks as Record<string, { hooks: ((i: any, id: string | undefined, o: any) => Promise<any>)[] }[]>;
  const pre = (input: Record<string, unknown>, id = 't1') => hooks.PreToolUse![0]!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_use_id: id, ...input }, id, { signal: new AbortController().signal });
  const start = (agent_id: string, agent_type: string) => hooks.SubagentStart![0]!.hooks[0]!({ hook_event_name: 'SubagentStart', agent_id, agent_type }, undefined, { signal: new AbortController().signal });
  const stop = (agent_id: string, agent_type: string) => hooks.SubagentStop![0]!.hooks[0]!({ hook_event_name: 'SubagentStop', agent_id, agent_type }, undefined, { signal: new AbortController().signal });
  return { s, out, hooks, pre, start, stop };
}

beforeEach(() => { fake.options = undefined; fake.interrupts = 0; fake.closed = 0; fake.queue = []; fake.ended = false; fake.waiter = undefined; });

const decisionOf = (r: any) => r?.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string; updatedInput?: Record<string, unknown> } | undefined;

describe('the agents option', () => {
  it('has exactly the delegates and only the fields the IDE allows', async () => {
    const { s } = await open({ delegates: THREE });
    const agents = fake.options.agents as Record<string, any>;
    expect(Object.keys(agents).sort()).toEqual(['developer', 'researcher', 'writer']);
    for (const a of Object.values(agents)) {
      expect(Object.keys(a).sort()).toEqual(expect.arrayContaining(['description', 'prompt', 'model', 'disallowedTools', 'maxTurns', 'background', 'omitClaudeMd']));
      for (const never of ['mcpServers', 'skills', 'memory', 'permissionMode', 'initialPrompt', 'observer', 'observerMessage', 'criticalSystemReminder_EXPERIMENTAL']) expect(a).not.toHaveProperty(never);
      expect(a.background).toBe(false);
      expect(a.omitClaudeMd).toBe(true);
      expect(a.disallowedTools).toEqual(expect.arrayContaining(['Agent', 'Task']));
    }
    expect(agents.researcher).toMatchObject({ description: 'Reads code', model: 'claude-haiku-4-5-20251001', tools: ['Read', 'Grep', 'Glob'], maxTurns: 25 });
    expect(agents.researcher.prompt.startsWith('PREAMBLE')).toBe(true);
    expect(agents.researcher).not.toHaveProperty('effort');
    expect(agents.developer).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 40 });
    expect(agents.developer, 'an empty tool list means "inherit", so the key is absent').not.toHaveProperty('tools');
    expect(agents.writer.maxTurns, 'default').toBe(120);
    expect(agents.researcher.disallowedTools).toEqual(['RemoteTrigger', 'Agent', 'Task']);
    await s.close();
  });

  it('buildAgents never duplicates Agent/Task and always adds them', () => {
    expect(buildAgents([delegate({ disallowedTools: [] })]).researcher!.disallowedTools).toEqual(['Agent', 'Task']);
    expect(buildAgents([delegate({ disallowedTools: ['Agent'] })]).researcher!.disallowedTools).toEqual(['Agent', 'Task']);
  });

  it('is absent for a single-role session, whose options are exactly what they were', async () => {
    const { s } = await open();
    expect(fake.options).not.toHaveProperty('agents');
    expect(Object.keys(fake.options.hooks)).toEqual(['PreToolUse']);
    expect(fake.options.disallowedTools).toEqual(['RemoteTrigger', 'EnterPlanMode']);
    expect(Object.keys(fake.options).sort()).toEqual([
      'canUseTool', 'cwd', 'disallowedTools', 'env', 'forwardSubagentText', 'hooks', 'includeHookEvents', 'includePartialMessages', 'mcpServers', 'model', 'pathToClaudeCodeExecutable',
      'permissionMode', 'sessionId', 'settingSources', 'settings', 'spawnClaudeCodeProcess', 'strictMcpConfig', 'systemPrompt', 'tools',
    ]);
    await s.close();
  });

  it('a delegating session adds only agents, the two subagent hooks and the hidden built-in agent types', async () => {
    const { s } = await open({ delegates: THREE });
    expect(Object.keys(fake.options.hooks).sort()).toEqual(['PreToolUse', 'SubagentStart', 'SubagentStop']);
    expect(fake.options.disallowedTools).toEqual(['RemoteTrigger', 'EnterPlanMode', ...LEAD_HIDDEN_AGENT_TYPES]);
    // an explicit default list, not the preset: the installed CLI's preset has no Glob and no Grep (see DEFAULT_TOOLS)
    expect(fake.options.tools).toEqual(expect.arrayContaining(['Agent', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write', 'AskUserQuestion', 'ExitPlanMode']));
    expect(fake.options.tools).not.toContain('ToolSearch');
    expect(fake.options.tools).not.toContainEqual({ type: 'preset', preset: 'claude_code' });
    await s.close();
  });

  it('keeps the settings isolation: no user settings, hooks, plugins, MCP or agent option', async () => {
    const { s } = await open({ delegates: THREE, mcp: { docs: { command: 'x' } } });
    const o = fake.options;
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.mcpServers).toEqual({ docs: { command: 'x' } });
    expect(o.settings).toEqual(settingsOverlay({ claudeBin: '/bin/claude', shimDir: '/shim' }, true));
    expect(o.settings).toMatchObject({ hooks: {}, enabledPlugins: {}, disableRemoteControl: true });
    for (const k of ['agent', 'plugins', 'skills', 'allowedTools']) expect(o).not.toHaveProperty(k);
    await s.close();
  });

  it('announces the roles once as session.info (without the prompts)', async () => {
    const { s, out } = await open({ delegates: THREE });
    const info = out.find((e) => e.kind === 'session.info' && 'delegates' in e) as Extract<WireEvent, { kind: 'session.info' }>;
    expect(info.delegates?.map((d) => d.name)).toEqual(['researcher', 'developer', 'writer']);
    expect(JSON.stringify(info)).not.toContain('Answer from the code');
    await s.close();
  });
});

describe('hook events and isolation', () => {
  const init = { type: 'system', subtype: 'init', session_id: 's', model: 'claude-sonnet-5-5', permissionMode: 'acceptEdits', apiKeySource: 'none', plugins: [], mcp_servers: [], agents: ['researcher', 'developer', 'writer', ...BUILTIN_AGENT_TYPES] };

  it('a SubagentStart hook event is ours; a Stop or UserPromptSubmit one still means the isolation leaked', async () => {
    const { s, out } = await open({ delegates: THREE });
    push(init);
    push({ type: 'system', subtype: 'hook_started', hook_event: 'SubagentStart' });
    push({ type: 'system', subtype: 'hook_response', hook_event: 'SubagentStop' });
    await tick();
    expect(out.filter((e) => e.kind === 'error')).toEqual([]);
    push({ type: 'system', subtype: 'hook_started', hook_event: 'Stop' });
    push({ type: 'system', subtype: 'hook_started', hook_event: 'UserPromptSubmit' });
    await tick();
    expect(out.filter((e) => e.kind === 'error')).toHaveLength(2);
    await s.close();
  });

  it('a classic session still treats a SubagentStart hook event as foreign', async () => {
    const { s, out } = await open();
    push({ ...init, agents: undefined });
    push({ type: 'system', subtype: 'hook_started', hook_event: 'SubagentStart' });
    await tick();
    expect(out.filter((e) => e.kind === 'error')).toHaveLength(1);
    await s.close();
  });
});

describe('per-role enforcement through the real gate (answers = the golden fixture)', () => {
  it('every golden case reaches policy with the intent the fixture holds, and the hook answers as the broker did', async () => {
    const seen: PolicyRequest[] = [];
    const { s, pre, start, stop } = await open({ delegates: THREE }, goldenPolicy(seen));
    let n = 0;
    const done = new Set<string>();
    for (const c of cases) {
      // the same intent can have different expectations under another run state (cap, strict background): the first one answers
      if (done.has(key(c.intent))) continue;
      done.add(key(c.intent));
      if (c.actor?.role === '?') continue; // the unknown-actor shape is covered below with a real SubagentStart in flight
      const id = `g${n++}`;
      if (c.actor) await start(c.actor.agentId, c.actor.role);
      const r = await pre({ tool_name: c.tool, tool_input: c.input, ...(c.actor ? { agent_id: c.actor.agentId, agent_type: c.actor.role } : {}) }, id);
      expect(key(seen.at(-1)!.intent), c.name).toBe(key(c.intent));
      if (c.actor) await stop(c.actor.agentId, c.actor.role);
      const out = decisionOf(r);
      if (c.expected.decision === 'deny') {
        expect(out?.permissionDecision, c.name).toBe('deny');
        expect(out?.permissionDecisionReason, c.name).toContain(DENY_MARK);
        expect(out?.permissionDecisionReason, c.name).toContain(c.expected.by);
        expect(out?.permissionDecisionReason, c.name).toContain(c.expected.rule);
      } else if (c.expected.decision === 'ask') {
        expect(out?.permissionDecision, c.name).toBe('ask');
      } else {
        expect(out?.permissionDecision === 'deny', c.name).toBe(false);
      }
    }
    expect(n).toBeGreaterThan(80);
    await s.close();
  });

  it('a read-only role Edit is denied with by roleDeny and leaves the request/resolved pair and the denied mark', async () => {
    const { s, pre, start, out } = await open({ delegates: THREE });
    await start('agent-1', 'researcher');
    const r = decisionOf(await pre({ tool_name: 'Edit', tool_input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, agent_id: 'agent-1', agent_type: 'researcher' }, 'e1'));
    expect(r).toMatchObject({ permissionDecision: 'deny' });
    expect(r?.permissionDecisionReason).toContain('roleDeny');
    const req = out.find((e) => e.kind === 'permission.request') as Extract<WireEvent, { kind: 'permission.request' }>;
    expect(req.intent.actor).toEqual({ agentId: 'agent-1', role: 'researcher' });
    expect(out.find((e) => e.kind === 'permission.resolved')).toMatchObject({ outcome: 'deny', by: 'roleDeny' });
    await s.close();
  });

  it('git commit and git push are hard stops for every role', async () => {
    const { s, pre, start } = await open({ delegates: THREE });
    for (const role of ['researcher', 'dev', 'writer']) {
      await start('agent-1', role);
      for (const command of ['git commit -m x', 'git push origin HEAD']) {
        const r = decisionOf(await pre({ tool_name: 'Bash', tool_input: { command }, agent_id: 'agent-1', agent_type: role }, `${role}-${command}`));
        expect(r?.permissionDecision, `${role} ${command}`).toBe('deny');
        expect(r?.permissionDecisionReason).toContain('hardStop');
      }
    }
    await s.close();
  });

  it('an agent_id the SubagentStart map does not know is sent with the hook agent_type, or with role ? when there is none', async () => {
    const seen: PolicyRequest[] = [];
    const { s, pre } = await open({ delegates: THREE }, goldenPolicy(seen));
    await pre({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' }, agent_id: 'zz', agent_type: 'researcher' }, 'a');
    expect(seen.at(-1)!.intent.actor).toEqual({ agentId: 'zz', role: 'researcher' });
    await pre({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' }, agent_id: 'zz2' }, 'b');
    expect(seen.at(-1)!.intent.actor).toEqual({ agentId: 'zz2', role: '?' });
    await s.close();
  });

  it('canUseTool takes the actor from agentID and the SubagentStart map', async () => {
    const seen: PolicyRequest[] = [];
    const { s, start } = await open({ delegates: THREE }, goldenPolicy(seen));
    await start('agent-1', 'writer');
    const r = await fake.options.canUseTool('Edit', { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' }, { signal: new AbortController().signal, toolUseID: 'c1', agentID: 'agent-1' });
    expect(seen.at(-1)!.intent.actor).toEqual({ agentId: 'agent-1', role: 'writer' });
    expect(r).toMatchObject({ behavior: 'allow' });
    await s.close();
  });

  it('the decision of a tool id is reused: one policy call per tool', async () => {
    let calls = 0;
    const { s, pre } = await open({ delegates: THREE }, { decide: async () => { calls++; return { decision: 'allow', by: 'default' }; } });
    await pre({ tool_name: 'Read', tool_input: { file_path: 'a' } }, 'same');
    await fake.options.canUseTool('Read', { file_path: 'a' }, { signal: new AbortController().signal, toolUseID: 'same' });
    expect(calls).toBe(1);
    await s.close();
  });

  it('a policy timeout or garbage for a sub-agent call denies as failClosed', async () => {
    for (const policy of [{ decide: async () => { throw new Error('timeout'); } }, { decide: async () => ({ junk: true }) as never }] as PolicyClient[]) {
      const { s, pre, start } = await open({ delegates: THREE }, policy);
      await start('agent-1', 'researcher');
      const r = decisionOf(await pre({ tool_name: 'Read', tool_input: { file_path: 'a' }, agent_id: 'agent-1', agent_type: 'researcher' }, 'f'));
      expect(r?.permissionDecision).toBe('deny');
      expect(r?.permissionDecisionReason).toContain('failClosed');
      await s.close();
    }
  });
});

describe('fail-closed attribution (spec 4.4, 5.6)', () => {
  const SPAWN = { subagent_type: 'researcher', prompt: 'look', description: 'look' };
  /** An `Agent` call is allowed (the golden cases do not hold one); everything else is answered by the golden fixture. */
  const spawnAllowed = (inner: PolicyClient): PolicyClient => ({ decide: async (req) => (req.intent.tool === 'Agent' ? { decision: 'allow', by: 'saved' } : inner.decide(req)) });

  it('a hook input WITHOUT agent_id while a sub-agent is in flight reaches policy with actor ? and is denied by the broker answer', async () => {
    const seen: PolicyRequest[] = [];
    const { s, pre, start, stop } = await open({ delegates: THREE }, spawnAllowed(goldenPolicy(seen)));
    await pre({ tool_name: 'Agent', tool_input: SPAWN }, 'ag1');
    await start('agent-1', 'researcher');
    const r = decisionOf(await pre({ tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }, 'x1'));
    expect(seen.at(-1)!.intent.actor).toEqual({ agentId: '?', role: '?' });
    expect(r?.permissionDecision).toBe('deny');
    await stop('agent-1', 'researcher');
    await pre({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } }, 'x2');
    expect(seen.at(-1)!.intent.actor, 'with no sub-agent in flight the caller is the lead').toBeUndefined();
    await s.close();
  });

  it('a sub-agent that ran out of turns never reports SubagentStop: its result still gives the lead back (the run used to deny everything after it)', async () => {
    const seen: PolicyRequest[] = [];
    const { s, pre, start } = await open({ delegates: THREE }, spawnAllowed(goldenPolicy(seen)));
    await pre({ tool_name: 'Agent', tool_input: SPAWN }, 'ag1');
    await start('agent-1', 'researcher');
    await pre({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' }, agent_id: 'agent-1', agent_type: 'researcher' }, 'sub1');
    expect(seen.at(-1)!.intent.actor).toEqual({ agentId: 'agent-1', role: 'researcher' });
    // no SubagentStop; the CLI hands the lead an error result for the Agent call
    push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ag1', is_error: true, content: 'Agent reached its max turns' }] } });
    await tick();
    for (const id of ['l1', 'l2', 'l3']) {
      await pre({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } }, id);
      expect(seen.at(-1)!.intent.actor, 'the lead is the lead again').toBeUndefined();
    }
    // a second delegation still works
    await pre({ tool_name: 'Agent', tool_input: SPAWN }, 'ag2');
    await start('agent-2', 'researcher');
    await pre({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } }, 'l4');
    expect(seen.at(-1)!.intent.actor).toEqual({ agentId: '?', role: '?' });
    // a message from INSIDE a sub-agent (parent_tool_use_id set) must not close the lead's Agent call; the end of the turn does
    push({ type: 'user', parent_tool_use_id: 'ag2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ag2', content: 'x' }] } });
    await tick();
    await pre({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } }, 'l5');
    expect(seen.at(-1)!.intent.actor).toEqual({ agentId: '?', role: '?' });
    push({ type: 'result', subtype: 'success', is_error: false, session_id: 's', result: 'done', total_cost_usd: 0, num_turns: 1, duration_ms: 1, duration_api_ms: 1, usage: {}, modelUsage: {}, permission_denials: [] });
    await tick();
    await pre({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } }, 'l6');
    expect(seen.at(-1)!.intent.actor).toBeUndefined();
    await s.close();
  });

  it('SubagentStop clears the agent map: a later call with that id and no agent_type is role ?', async () => {
    const seen: PolicyRequest[] = [];
    const { s, pre, start, stop } = await open({ delegates: THREE }, goldenPolicy(seen));
    await start('agent-1', 'researcher');
    await pre({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' }, agent_id: 'agent-1' }, 'y1');
    expect(seen.at(-1)!.intent.actor).toEqual({ agentId: 'agent-1', role: 'researcher' });
    await stop('agent-1', 'researcher');
    await pre({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' }, agent_id: 'agent-1' }, 'y2');
    expect(seen.at(-1)!.intent.actor).toEqual({ agentId: 'agent-1', role: '?' });
    await s.close();
  });

  it('two sub-agents at once: the one still running keeps its role after the other stops', async () => {
    const seen: PolicyRequest[] = [];
    const { s, pre, start, stop } = await open({ delegates: THREE }, spawnAllowed(goldenPolicy(seen)));
    await pre({ tool_name: 'Agent', tool_input: SPAWN }, 'ag1');
    await pre({ tool_name: 'Agent', tool_input: { ...SPAWN, subagent_type: 'writer' } }, 'ag2');
    await start('a', 'researcher');
    await start('b', 'writer');
    await stop('a', 'researcher');
    await pre({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' }, agent_id: 'b' }, 'z1');
    expect(seen.at(-1)!.intent.actor).toEqual({ agentId: 'b', role: 'writer' });
    await pre({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } }, 'z2');
    expect(seen.at(-1)!.intent.actor, 'b is still in flight: an actorless call is not the lead').toEqual({ agentId: '?', role: '?' });
    await s.close();
  });

  it('the canary: an actorless tool call inside a sub-agent message emits error policy, interrupts, and every later call is denied', async () => {
    const seen: PolicyRequest[] = [];
    const { s, pre, out } = await open({ delegates: THREE }, { decide: async (r) => { seen.push(r); return { decision: 'allow', by: 'default' }; } });
    // no SubagentStart was ever delivered, so nothing marks the call as a sub-agent's: exactly the failure the canary is for
    await pre({ tool_name: 'Edit', tool_input: { file_path: 'src/a.ts' } }, 'toolu_sub');
    push({ type: 'assistant', parent_tool_use_id: 'toolu_agent', message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_sub', name: 'Edit', input: { file_path: 'src/a.ts' } }] } });
    await tick();
    const err = out.find((e) => e.kind === 'error') as Extract<WireEvent, { kind: 'error' }>;
    expect(err).toMatchObject({ class: 'policy', retryable: false });
    expect(err.message.startsWith(CANARY_MARK)).toBe(true);
    expect(fake.interrupts).toBe(1);
    const after = decisionOf(await pre({ tool_name: 'Read', tool_input: { file_path: 'a' } }, 'later'));
    expect(after?.permissionDecision).toBe('deny');
    expect(after?.permissionDecisionReason).toContain('failClosed');
    expect(seen).toHaveLength(1);
    await s.close();
  });

  it('the canary also fires when the message arrives before the hook, and only once', async () => {
    const { s, pre, out } = await open({ delegates: THREE }, { decide: async () => ({ decision: 'allow', by: 'default' }) });
    push({ type: 'assistant', parent_tool_use_id: 'toolu_agent', message: { id: 'm1', content: [{ type: 'tool_use', id: 'toolu_sub', name: 'Bash', input: { command: 'ls' } }] } });
    await tick();
    expect(out.filter((e) => e.kind === 'error')).toHaveLength(0);
    await pre({ tool_name: 'Bash', tool_input: { command: 'ls' } }, 'toolu_sub');
    await pre({ tool_name: 'Bash', tool_input: { command: 'ls' } }, 'toolu_sub2');
    expect(out.filter((e) => e.kind === 'error')).toHaveLength(1);
    expect(fake.interrupts).toBe(1);
    await s.close();
  });

  it('no canary for a lead tool call or for an attributed sub-agent call', async () => {
    const { s, pre, start, out } = await open({ delegates: THREE }, { decide: async () => ({ decision: 'allow', by: 'default' }) });
    await start('agent-1', 'researcher');
    await pre({ tool_name: 'Read', tool_input: { file_path: 'a' }, agent_id: 'agent-1', agent_type: 'researcher' }, 'ok1');
    push({ type: 'assistant', parent_tool_use_id: 'toolu_agent', message: { id: 'm1', content: [{ type: 'tool_use', id: 'ok1', name: 'Read', input: { file_path: 'a' } }] } });
    push({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'tool_use', id: 'lead1', name: 'Read', input: { file_path: 'a' } }] } });
    await tick();
    expect(out.filter((e) => e.kind === 'error')).toEqual([]);
    expect(fake.interrupts).toBe(0);
    await s.close();
  });
});

describe('the Agent tool call', () => {
  it('rewrites an allowed call: no model/isolation/mode/team_name, run_in_background false', async () => {
    const { s, pre } = await open({ delegates: THREE }, { decide: async () => ({ decision: 'allow', by: 'default', rule: 'delegate.spawn' }) });
    const r = decisionOf(await pre({ tool_name: 'Agent', tool_input: { subagent_type: 'researcher', description: 'd', prompt: 'p', model: 'opus', isolation: 'worktree', team_name: 't', mode: 'plan', name: 'n' } }, 'ag1'));
    expect(r).toMatchObject({ hookEventName: 'PreToolUse', permissionDecision: 'allow' });
    expect(r?.updatedInput).toEqual({ subagent_type: 'researcher', description: 'd', prompt: 'p', name: 'n', run_in_background: false });
    await s.close();
  });

  it('turns an omitted run_in_background into false and leaves other tools alone', async () => {
    const { s, pre } = await open({ delegates: THREE }, { decide: async () => ({ decision: 'allow', by: 'default' }) });
    expect(decisionOf(await pre({ tool_name: 'Agent', tool_input: { subagent_type: 'writer', prompt: 'p' } }, 'ag2'))?.updatedInput).toMatchObject({ run_in_background: false });
    expect(await pre({ tool_name: 'Read', tool_input: { file_path: 'a' } }, 'rd1')).toEqual({ continue: true });
    await s.close();
  });

  it('a denied call returns the denial, not a rewrite', async () => {
    const { s, pre } = await open({ delegates: THREE }, { decide: async () => ({ decision: 'deny', by: 'roleDeny', reason: 'do not set model; the role decides', rule: 'delegate.model' }) });
    const r = decisionOf(await pre({ tool_name: 'Agent', tool_input: { subagent_type: 'researcher', model: 'opus' } }, 'ag3'));
    expect(r?.permissionDecision).toBe('deny');
    expect(r).not.toHaveProperty('updatedInput');
    expect(r?.permissionDecisionReason).toContain('delegate.model');
    await s.close();
  });

  it('a single-role session only moves the call to the foreground (the CLI would background it and outlive the turn); the rest is untouched', async () => {
    const { s, pre } = await open({}, { decide: async () => ({ decision: 'allow', by: 'default' }) });
    expect(await pre({ tool_name: 'Agent', tool_input: { subagent_type: 'researcher', model: 'opus' } }, 'ag4')).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { subagent_type: 'researcher', model: 'opus', run_in_background: false } },
    });
    await s.close();
  });

  it('rewriteAgentInput is total', () => {
    expect(rewriteAgentInput(undefined)).toEqual({ run_in_background: false });
    expect(rewriteAgentInput('x')).toEqual({ run_in_background: false });
    expect(rewriteAgentInput({ run_in_background: true, prompt: 'p' })).toEqual({ prompt: 'p', run_in_background: false });
  });
});

describe('facts and usage', () => {
  const init = (agents: string[]) => ({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', permissionMode: 'acceptEdits', apiKeySource: 'none', plugins: [], mcp_servers: [], agents });
  const base = { role: { name: 'auto', model: 'claude-sonnet-5-5', permission: 'edit' as const }, mcpExpected: [], models: [], appliedEffort: null, foreignHookEvents: 0 };

  it('flags a delegate the CLI does not know, and an agent that leaked in, but not the built-ins', () => {
    const names = ['researcher', 'developer'];
    expect(assertInit({ ...base, init: init(['researcher', 'developer', ...BUILTIN_AGENT_TYPES]), delegateNames: names, settingSources: [] })).toEqual([]);
    expect(assertInit({ ...base, init: init(['researcher', ...BUILTIN_AGENT_TYPES]), delegateNames: names, settingSources: [] }).join()).toContain('role developer not known to the CLI');
    expect(assertInit({ ...base, init: init(['researcher', 'developer', 'my-user-agent']), delegateNames: names, settingSources: [] }).join()).toContain('agent my-user-agent leaked despite settingSources: []');
  });

  it('does not call project agents a leak when the session loads project settings, and does not check a classic session', () => {
    expect(assertInit({ ...base, init: init(['researcher', 'proj-agent']), delegateNames: ['researcher'], settingSources: ['project'] })).toEqual([]);
    expect(assertInit({ ...base, init: init(['whatever']) })).toEqual([]);
  });

  it('a missing agents list in init is every delegate missing', () => {
    expect(assertInit({ ...base, init: { ...init([]), agents: undefined }, delegateNames: ['researcher'], settingSources: [] }).join()).toContain('researcher not known');
  });

  it('the session turns a missing delegate into an init assertion on session.started', async () => {
    const { s, out } = await open({ delegates: THREE });
    push(init(['researcher', 'developer', ...BUILTIN_AGENT_TYPES]));
    await tick();
    const started = out.find((e) => e.kind === 'session.started') as Extract<WireEvent, { kind: 'session.started' }>;
    expect(started.assertions?.join()).toContain('role writer not known to the CLI');
    await s.close();
  });

  it('modelUsage becomes per-model cumulative tokens next to the existing fields', () => {
    const state = newMapState();
    const result = (mu: Record<string, unknown>) => ({ type: 'result', subtype: 'success', is_error: false, modelUsage: mu });
    const ev = mapRaw(state, result({
      'claude-sonnet-5-5': { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.5, contextWindow: 200000 },
      'claude-haiku-4-5-20251001': { inputTokens: 40, outputTokens: 10, cacheReadInputTokens: 5, cacheCreationInputTokens: 0, costUSD: 0.01, contextWindow: 200000 },
    })).find((e) => e.kind === 'usage') as Extract<WireEvent, { kind: 'usage' }>;
    expect(ev.usage.perModel?.map((m) => m.model)).toEqual(['claude-sonnet-5-5', 'claude-haiku-4-5-20251001']);
    expect(ev.usage.perModel?.[1]?.tokens).toMatchObject({ inputTokens: 40, outputTokens: 10, cacheRead: 5, costUsd: 0.01 });
    expect(ev.usage.model, 'the model with the largest delta stays').toBe('claude-sonnet-5-5');
    // the second turn reports cumulative totals again: per-model stays cumulative, perTurn is the delta
    const ev2 = mapRaw(state, result({
      'claude-sonnet-5-5': { inputTokens: 150, outputTokens: 30, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.7 },
      'claude-haiku-4-5-20251001': { inputTokens: 40, outputTokens: 10, cacheReadInputTokens: 5, cacheCreationInputTokens: 0, costUSD: 0.01 },
    })).find((e) => e.kind === 'usage') as Extract<WireEvent, { kind: 'usage' }>;
    expect(ev2.usage.perModel?.[0]?.tokens.inputTokens).toBe(150);
    expect(ev2.usage.perTurn.inputTokens).toBe(50);
  });
});
