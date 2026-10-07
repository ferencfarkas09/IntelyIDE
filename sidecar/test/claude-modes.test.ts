// The five IDE modes in the Claude adapter, against a fake SDK (permission-modes spec 6.1, 6.2, 6.4, 8.3 S-2, S-3b, S-4, S-5):
// the SDK mode and options per mode, the D12 note, the live switch, the plan-approval path through a session, the mapper.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDE_PLAN_NOTE, IDE_SESSION_NOTE } from '../src/adapters/claude-sdk/notes.js';
import { mapRaw, newMapState } from '../src/adapters/claude-sdk/map.js';
import { ClaudeSession } from '../src/adapters/claude-sdk/session.js';
import { SeqSink, TurnGuard } from '../src/turn.js';
import type { PermissionMode, PolicyClient, PolicyDecision, SessionSpec, WireEvent } from '../src/types.js';

// The user's own CLAUDE.md rides on every session prompt (agents.includeUserMemory): the developer's real one stays out of the assertions.
const savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
beforeAll(() => { process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'isw-modes-cfg-')); });
afterAll(() => { if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedConfigDir; });

// ---------- fake SDK ----------
const fake = vi.hoisted(() => {
  const state: {
    options: any; closed: number; queue: any[]; waiter?: () => void; ended: boolean;
    setModeCalls: string[]; setModeImpl: (m: string) => Promise<void>;
  } = { options: undefined, closed: 0, queue: [], ended: false, setModeCalls: [], setModeImpl: async () => undefined };
  return state;
});

vi.mock('../src/sdk.js', () => ({
  loadSdk: async () => ({
    query: ({ options }: { options: any }) => {
      fake.options = options;
      return {
        initializationResult: async () => ({ models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high'] }] }),
        getSettings: async () => ({ applied: { effort: null } }),
        interrupt: async () => undefined,
        close: () => { fake.closed++; fake.ended = true; fake.waiter?.(); },
        setModel: async () => undefined,
        setPermissionMode: async (m: string) => { fake.setModeCalls.push(m); await fake.setModeImpl(m); },
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

const ALLOW: PolicyDecision = { decision: 'allow', by: 'saved' };
function spec(mode: PermissionMode, over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    agentId: 'a1', provider: 'claude', role: { name: 'dev', model: 'claude-sonnet-5-5', permission: mode }, cwd: '/tmp/x', addDirs: [],
    env: { claudeBin: '/bin/claude', shimDir: '/shim' }, mcp: {}, auth: { mode: 'subscription', key: null }, ...over,
  };
}
async function open(mode: PermissionMode, over: Partial<SessionSpec> = {}, policy: PolicyClient = { decide: async () => ALLOW }) {
  const out: WireEvent[] = [];
  const guard = new TurnGuard(new SeqSink((e) => out.push(e)));
  guard.beginTurn();
  const s = await ClaudeSession.open(spec(mode, over), guard, policy, { registerPid: () => undefined });
  const hooks = fake.options.hooks as Record<string, { hooks: ((i: any, id: string | undefined, o: any) => Promise<any>)[] }[]>;
  const pre = (input: Record<string, unknown>, id = 't1') => hooks.PreToolUse![0]!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_use_id: id, ...input }, id, { signal: new AbortController().signal });
  const can = (tool: string, input: Record<string, unknown>, id = 't1', extra: Record<string, unknown> = {}) => (fake.options.canUseTool as any)(tool, input, { signal: new AbortController().signal, toolUseID: id, ...extra });
  return { s, out, pre, can };
}
const kinds = (out: WireEvent[], kind: string) => out.filter((e) => e.kind === kind) as any[];

beforeEach(() => { fake.options = undefined; fake.closed = 0; fake.queue = []; fake.ended = false; fake.waiter = undefined; fake.setModeCalls = []; fake.setModeImpl = async () => undefined; });
afterEach(() => { vi.useRealTimers(); });

describe('session options per mode (S-2)', () => {
  it.each([['readOnly', 'plan'], ['ask', 'default'], ['edit', 'acceptEdits'], ['automatic', 'acceptEdits'], ['bypass', 'acceptEdits']] as const)('%s runs as the SDK mode %s, with no dangerous-skip flag', async (mode, sdk) => {
    const { s } = await open(mode);
    expect(fake.options.permissionMode).toBe(sdk);
    expect(fake.options).not.toHaveProperty('allowDangerouslySkipPermissions');
    expect(fake.options.permissionMode).not.toBe('bypassPermissions');
    await s.close();
  });

  it('plansDirectory comes from planDir (an absolute path) and is absent without one', async () => {
    const a = await open('readOnly', { planDir: '/ide/state/plans/a1' });
    expect(fake.options.settings.plansDirectory).toBe('/ide/state/plans/a1');
    await a.s.close();
    const b = await open('readOnly');
    expect(fake.options.settings).not.toHaveProperty('plansDirectory');
    await b.s.close();
  });

  it('every session appends the D12 note, with and without a role prompt, role prompt first', async () => {
    const a = await open('ask');
    expect(fake.options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: `${IDE_SESSION_NOTE}\n\n${IDE_PLAN_NOTE}` });
    await a.s.close();
    const b = await open('edit', { role: { name: 'dev', model: 'claude-sonnet-5-5', permission: 'edit', systemPrompt: 'You are the developer.' } });
    expect(fake.options.systemPrompt.append).toBe(`You are the developer.\n\n${IDE_SESSION_NOTE}\n\n${IDE_PLAN_NOTE}`);
    await b.s.close();
  });

  it('the CLAUDE.md files of the working directory and of the added directories ride in the system prompt, after the notes; the CLI is not asked to load them', async () => {
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isw-cm-')));
    const add = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'isw-cm-')));
    fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'Backend rule: never commit.');
    fs.writeFileSync(path.join(add, 'CLAUDE.md'), 'The secret marker is ZEBRA-SEVEN-4821.');
    try {
      const a = await open('ask', { cwd, addDirs: [add] });
      const append: string = fake.options.systemPrompt.append;
      expect(append.startsWith(IDE_SESSION_NOTE)).toBe(true);
      expect(append.indexOf('Project instructions.')).toBeGreaterThan(append.indexOf(IDE_PLAN_NOTE));
      expect(append).toContain('Backend rule: never commit.');
      expect(append).toContain('ZEBRA-SEVEN-4821');
      // the directories travel inside the inline settings, never as the flag that would load the user's plugins and hooks
      expect(fake.options).not.toHaveProperty('additionalDirectories');
      expect(fake.options.settings.permissions.additionalDirectories).toEqual([add]);
      await a.s.close();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(add, { recursive: true, force: true });
    }
  });

  it('the D12 note says what it must: optimizer tools and ToolSearch are not available, ignore CLAUDE.md about them, never EnterPlanMode', () => {
    for (const needle of ['smart_read', 'smart_grep', 'smart_glob', 'smart_edit', 'smart_write', 'ToolSearch', 'NOT available', 'CLAUDE.md', 'EnterPlanMode']) expect(IDE_SESSION_NOTE).toContain(needle);
    expect(IDE_SESSION_NOTE).not.toMatch(/[\u{1F300}-\u{1FAFF}☀-➿]/u); // no emojis anywhere
  });

  it('EnterPlanMode is hidden from every session (lead or not) and ToolSearch never is', async () => {
    const a = await open('ask');
    expect(fake.options.disallowedTools).toContain('EnterPlanMode');
    expect(fake.options.disallowedTools).not.toContain('ToolSearch');
    await a.s.close();
    const b = await open('automatic', { delegates: [{ name: 'researcher', description: 'd', prompt: 'p', model: 'claude-haiku-4-5-20251001', permission: 'readOnly', tools: ['Read'], disallowedTools: [], scope: 'global' } as never] });
    expect(fake.options.disallowedTools).toContain('EnterPlanMode');
    expect(fake.options.disallowedTools).not.toContain('ToolSearch');
    await b.s.close();
  });

  it('keeps strict MCP isolation in every mode: the expected server names are exactly the ones passed', async () => {
    for (const mode of ['readOnly', 'ask', 'edit', 'automatic', 'bypass'] as const) {
      const { s } = await open(mode, { mcp: { docs: { command: 'x' } } });
      expect(fake.options.strictMcpConfig).toBe(true);
      expect(fake.options.settingSources).toEqual([]);
      expect(fake.options.settings).toMatchObject({ hooks: {}, enabledPlugins: {} });
      await s.close();
    }
  });
});

describe('the session reports the IDE mode it holds, never one derived from the SDK (S-5)', () => {
  const initMsg = (permissionMode: string) => ({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5-5', permissionMode, apiKeySource: 'none', plugins: [], mcp_servers: [] });
  it.each([['ask', 'default'], ['automatic', 'acceptEdits'], ['bypass', 'acceptEdits'], ['readOnly', 'plan']] as const)('session.started says %s although the CLI reports %s', async (mode, sdk) => {
    const { s, out } = await open(mode);
    push(initMsg(sdk));
    await tick(15);
    const started = kinds(out, 'session.started')[0];
    expect(started.effective.permission).toBe(mode);
    expect(started.assertions ?? []).toEqual([]); // the init mode matches what the session expects
    await s.close();
  });
  it('a live switch is what the NEXT init is compared against (the init facts follow the current mode)', async () => {
    const { s, out } = await open('ask');
    await s.setPermission('automatic');
    push(initMsg('acceptEdits'));
    await tick(15);
    expect(kinds(out, 'session.started')[0].assertions ?? []).toEqual([]);
    await s.close();
  });
  it('a CLI that reports another mode than the session holds is flagged', async () => {
    const { s, out } = await open('automatic');
    push(initMsg('default'));
    await tick(15);
    expect(kinds(out, 'session.started')[0].assertions.join()).toContain('expected "acceptEdits", CLI reports "default"');
    await s.close();
  });
  it('the mapper emits no `plan` event for ExitPlanMode (the approval card carries the text) and still maps TodoWrite', () => {
    const state = newMapState({ mode: () => 'readOnly' });
    const evs = mapRaw(state, { type: 'assistant', message: { id: 'm1', content: [
      { type: 'text', text: 'Here is the plan.' },
      { type: 'tool_use', id: 'x1', name: 'ExitPlanMode', input: { plan: '# P', planFilePath: '/p' } },
      { type: 'tool_use', id: 'x2', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'pending' }] } },
    ] } });
    expect(evs.map((e) => e.kind)).toEqual(['text.done', 'tool.start', 'tool.start', 'plan']);
    expect((evs.find((e) => e.kind === 'plan') as any).items).toEqual([{ content: 'a', status: 'pending' }]);
    expect(state.lastText).toBe('Here is the plan.');
    mapRaw(state, { type: 'result', subtype: 'success', is_error: false });
    expect(state.lastText).toBeUndefined(); // reset at the end of the turn
  });
  it('lastText ignores sub-agent text and feeds the plan fallback of the gate', async () => {
    const { s, out, can } = await open('readOnly', {}, { decide: async () => ({ decision: 'ask', by: 'roleDeny', rule: 'other.exit-plan' }) });
    push({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'The real plan text.' }] } });
    push({ type: 'assistant', parent_tool_use_id: 'agent1', message: { id: 'm2', content: [{ type: 'text', text: 'sub-agent chatter' }] } });
    await tick(15);
    void can('ExitPlanMode', {}, 'x9');
    await tick();
    expect(kinds(out, 'permission.request')[0]).toMatchObject({ plan: 'The real plan text.', modes: ['ask', 'edit', 'automatic'] });
    await s.close();
  });
});

describe('setPermission, the live switch (S-4)', () => {
  it('calls setPermissionMode with the SDK mode and reports session.info{permission, user}', async () => {
    const { s, out } = await open('ask');
    await s.setPermission('readOnly');
    await s.setPermission('automatic');
    expect(fake.setModeCalls).toEqual(['plan', 'acceptEdits']);
    expect(kinds(out, 'session.info').filter((e) => e.effective)).toMatchObject([{ effective: { permission: 'readOnly', reason: 'user' } }, { effective: { permission: 'automatic', reason: 'user' } }]);
    await s.close();
  });

  it('repeating the CURRENT mode only advances the epoch: no CLI call, no event, but the next canUseTool decides again', async () => {
    let calls = 0;
    const { s, out, pre, can } = await open('automatic', {}, { decide: async () => { calls++; return ALLOW; } });
    await pre({ tool_name: 'Write', tool_input: { file_path: '/tmp/x/a' } }, 'r1');
    await s.setPermission('automatic');
    expect(fake.setModeCalls).toEqual([]);
    expect(kinds(out, 'session.info').filter((e) => e.effective)).toHaveLength(0);
    await can('Write', { file_path: '/tmp/x/a' }, 'r1');
    expect(calls).toBe(2);
    await s.close();
  });

  it('a call allowed under automatic is denied when canUseTool runs after a switch to readOnly, and shows a card after a switch to ask', async () => {
    let mode: PermissionMode = 'automatic';
    const policy: PolicyClient = { decide: async () => (mode === 'automatic' ? ALLOW : mode === 'readOnly' ? { decision: 'deny', by: 'roleDeny', reason: 'plan only', rule: 'role.read-only' } : { decision: 'ask', by: 'roleDeny' }) };
    const { s, out, pre, can } = await open('automatic', {}, policy);
    await pre({ tool_name: 'Bash', tool_input: { command: 'make' } }, 'sw1');
    await pre({ tool_name: 'Bash', tool_input: { command: 'make' } }, 'sw2');
    mode = 'readOnly'; await s.setPermission('readOnly');
    expect(await can('Bash', { command: 'make' }, 'sw1')).toMatchObject({ behavior: 'deny', message: expect.stringContaining('role.read-only') });
    mode = 'ask'; await s.setPermission('ask');
    void can('Bash', { command: 'make' }, 'sw2');
    await tick();
    expect(kinds(out, 'permission.request').filter((e) => e.reqId === 'perm-sw2').at(-1)).toMatchObject({ options: ['allow_once', 'deny'] });
    await s.close();
  });

  it('a CLI refusal throws, and the session keeps the NEW mode for its own view (Rust is authoritative; the host re-sends the old mode when it rolls back)', async () => {
    const { s, out, pre } = await open('automatic', {}, { decide: async () => ({ decision: 'ask', by: 'roleDeny' }) });
    fake.setModeImpl = async () => { throw new Error('Cannot set permission mode'); };
    await expect(s.setPermission('ask')).rejects.toThrow('Cannot set permission mode');
    expect(kinds(out, 'session.info').filter((e) => e.effective)).toHaveLength(0);
    // the gate's view is Ask now: an Ask verdict is a card, not the unattended-guard denial
    void pre({ tool_name: 'Bash', tool_input: { command: 'make' } }, 'rf1');
    await tick();
    expect(decisionOf(await pre({ tool_name: 'Bash', tool_input: { command: 'make' } }, 'rf2'))).toMatchObject({ permissionDecision: 'ask' });
    // and the host rolling back re-sends the old mode, which goes through again
    fake.setModeImpl = async () => undefined;
    await s.setPermission('automatic');
    expect(fake.setModeCalls.at(-1)).toBe('acceptEdits');
    await s.close();
  });

  it('times out after 5 s with a message that starts with "timeout"', async () => {
    vi.useFakeTimers();
    const { s } = await open('ask');
    fake.setModeImpl = () => new Promise(() => undefined);
    const p = s.setPermission('readOnly');
    const caught = p.then(() => new Error('did not time out'), (e: Error) => e);
    await vi.advanceTimersByTimeAsync(5001);
    expect((await caught).message).toMatch(/^timeout: setPermissionMode/);
    await s.close();
  });

  it('refuses a mode with no SDK mapping before any state moves', async () => {
    const { s } = await open('ask');
    await expect(s.setPermission('dontAsk' as never)).rejects.toThrow(/not offered for Claude/);
    expect(fake.setModeCalls).toEqual([]);
    await s.close();
  });
});

describe('ExitPlanMode through a session', () => {
  it('approving switches the sidecar view and answers the CLI with setMode; the next init is compared with the new mode', async () => {
    const { s, out, can } = await open('readOnly', {}, { decide: async () => ({ decision: 'ask', by: 'roleDeny', rule: 'other.exit-plan' }) });
    const p = can('ExitPlanMode', { plan: 'go' }, 'ep1');
    await tick();
    s.answer('perm-ep1', { outcome: 'allow', mode: 'automatic' });
    expect(await p).toMatchObject({ behavior: 'allow', updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
    expect(kinds(out, 'session.info').find((e) => e.effective)).toMatchObject({ effective: { permission: 'automatic', reason: 'planApproved' } });
    push({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5-5', permissionMode: 'acceptEdits', apiKeySource: 'none', plugins: [], mcp_servers: [] });
    await tick(15);
    expect(kinds(out, 'session.started')[0]).toMatchObject({ effective: { permission: 'automatic' } });
    expect(kinds(out, 'session.started')[0].assertions ?? []).toEqual([]);
    await s.close();
  });
});

const decisionOf = (r: any) => r?.hookSpecificOutput as { permissionDecision?: string } | undefined;
