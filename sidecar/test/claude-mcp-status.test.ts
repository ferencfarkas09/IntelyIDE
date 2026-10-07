// The CLI's slash commands and MCP servers in `session.info` (from system/init) and the live `mcpStatus()` of a Claude session, against a fake SDK.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initSessionInfo, mcpState } from '../src/adapters/claude-sdk/facts.js';
import { ClaudeSession } from '../src/adapters/claude-sdk/session.js';
import { SidecarHost } from '../src/host.js';
import { Loader } from '../src/loader.js';
import { ProtocolClient } from '../src/protocol.js';
import { SeqSink, TurnGuard } from '../src/turn.js';
import type { AgentProvider, SessionSpec, WireEvent } from '../src/types.js';

const fake = vi.hoisted(() => {
  const state: { queue: any[]; waiter?: () => void; ended: boolean; calls: string[]; status: any[]; failStatus?: string } = { queue: [], ended: false, calls: [], status: [] };
  return state;
});

vi.mock('../src/sdk.js', () => ({
  loadSdk: async () => ({
    query: () => ({
      initializationResult: async () => ({ models: [{ value: 'sonnet', resolvedModel: 'claude-sonnet-5-5' }] }),
      getSettings: async () => ({ applied: { effort: null } }),
      interrupt: async () => undefined,
      close: () => { fake.ended = true; fake.waiter?.(); },
      setPermissionMode: async () => undefined,
      reconnectMcpServer: async (n: string) => { fake.calls.push(`reconnect:${n}`); },
      toggleMcpServer: async (n: string, on: boolean) => { fake.calls.push(`toggle:${n}:${on}`); },
      mcpServerStatus: async () => { if (fake.failStatus) throw new Error(fake.failStatus); fake.calls.push('status'); return fake.status; },
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
    }),
  }),
  SdkError: class extends Error {},
}));

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const push = (m: unknown) => { fake.queue.push(m); fake.waiter?.(); };
beforeEach(() => { fake.queue = []; fake.ended = false; fake.calls = []; fake.status = []; fake.failStatus = undefined; });

const spec = (mcp: SessionSpec['mcp']): SessionSpec => ({
  agentId: 'a1', provider: 'claude', role: { name: 'dev', model: 'claude-sonnet-5-5', permission: 'ask' }, cwd: '/tmp/x', addDirs: [],
  env: { claudeBin: '/bin/claude', shimDir: '/shim' }, mcp, auth: { mode: 'subscription', key: null },
});
const init = (over: Record<string, unknown> = {}) => ({
  type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5-5', permissionMode: 'default', apiKeySource: 'none', plugins: [], agents: [], ...over,
});
async function open(mcp: SessionSpec['mcp'] = { github: { command: 'x' }, docs: { command: 'y' } }) {
  const out: WireEvent[] = [];
  const guard = new TurnGuard(new SeqSink((e) => out.push(e)));
  guard.beginTurn();
  const s = await ClaudeSession.open(spec(mcp), guard, { decide: async () => ({ decision: 'allow', by: 'saved' }) }, { registerPid: () => undefined });
  return { s, out };
}
const infos = (out: WireEvent[]) => out.filter((e) => e.kind === 'session.info') as any[];

describe('initSessionInfo', () => {
  it('keeps the command names (no slash, no blanks, no duplicates) and the servers with state and tool count', () => {
    const r = initSessionInfo(init({
      slash_commands: ['compact', '/review', 'compact', 'a b', '', 7],
      tools: ['Read', 'mcp__github__search', 'mcp__github__get', 'mcp__other__x'],
      mcp_servers: [{ name: 'github', status: 'connected' }, { name: 'docs', status: 'needs-auth' }, { name: 'bad', status: 'failed', error: 'spawn ENOENT' }, { status: 'connected' }],
    }), (s) => s);
    expect(r.slashCommands).toEqual(['compact', 'review']);
    expect(r.mcpServers).toEqual([
      { name: 'github', status: 'connected', tools: 2 },
      { name: 'docs', status: 'needsAuth' },
      { name: 'bad', status: 'failed', error: 'spawn ENOENT' },
    ]);
  });

  it('is empty for an init without them, and bounds the lists and the error text', () => {
    expect(initSessionInfo(init(), (s) => s)).toEqual({ slashCommands: [], mcpServers: [] });
    const many = initSessionInfo(init({ slash_commands: Array.from({ length: 500 }, (_, i) => `c${i}`), mcp_servers: [{ name: 'x', status: 'failed', error: 'e'.repeat(1000) }] }), (s) => s);
    expect(many.slashCommands).toHaveLength(300);
    expect(many.mcpServers[0]!.error!.length).toBeLessThanOrEqual(300);
  });

  it('runs error text through the scrubber and maps states to the wire names', () => {
    const r = initSessionInfo(init({ mcp_servers: [{ name: 'x', status: 'failed', error: 'token abc123' }] }), (s) => s.replace('abc123', '[redacted]'));
    expect(r.mcpServers[0]!.error).toBe('token [redacted]');
    expect(['connected', 'failed', 'pending', 'disabled', 'needs-auth', 'weird', undefined].map(mcpState)).toEqual(['connected', 'failed', 'pending', 'disabled', 'needsAuth', 'pending', 'pending']);
  });
});

describe('ClaudeSession: init -> session.info', () => {
  it('forwards slashCommands and mcpServers right after session.started', async () => {
    const { out } = await open();
    push(init({ slash_commands: ['compact', 'context'], tools: ['mcp__github__a'], mcp_servers: [{ name: 'github', status: 'connected' }, { name: 'docs', status: 'needs-auth' }] }));
    await tick();
    const kinds = out.map((e) => e.kind);
    expect(kinds.indexOf('session.started')).toBeGreaterThanOrEqual(0);
    const info = infos(out).find((e) => e.slashCommands);
    expect(out.indexOf(info)).toBeGreaterThan(kinds.indexOf('session.started'));
    expect(info).toMatchObject({ slashCommands: ['compact', 'context'], mcpServers: [{ name: 'github', status: 'connected', tools: 1 }, { name: 'docs', status: 'needsAuth' }] });
  });

  it('sends the info once, and nothing extra for an init without commands or servers', async () => {
    const a = await open({});
    push(init());
    await tick();
    expect(infos(a.out).filter((e) => e.slashCommands || e.mcpServers)).toHaveLength(0);
    const b = await open();
    push(init({ slash_commands: ['compact'], mcp_servers: [{ name: 'github', status: 'connected' }, { name: 'docs', status: 'connected' }] }));
    push(init({ slash_commands: ['compact'], mcp_servers: [{ name: 'github', status: 'failed' }, { name: 'docs', status: 'connected' }] }));
    await tick();
    expect(infos(b.out).filter((e) => e.slashCommands)).toHaveLength(1);
  });
});

describe('ClaudeSession.mcpStatus', () => {
  it('returns the servers with their states, redacted errors and tool names', async () => {
    const { s } = await open();
    fake.status = [
      { name: 'github', status: 'connected', serverInfo: { name: 'gh', version: '1' }, config: { type: 'stdio', command: 'x', env: { TOKEN: 'secret-value' } }, tools: [{ name: 'search', description: 'Search issues', annotations: { readOnly: true } }, { name: 'get' }] },
      { name: 'docs', status: 'needs-auth', error: 'login required' },
    ];
    const r = await s.mcpStatus();
    expect(r).toEqual([
      { name: 'github', status: 'connected', tools: [{ name: 'search', description: 'Search issues' }, { name: 'get' }] },
      { name: 'docs', status: 'needsAuth', error: 'login required', tools: [] },
    ]);
    expect(JSON.stringify(r)).not.toContain('secret-value');
  });

  it('reconnects or toggles one server first, then reads the status', async () => {
    const { s } = await open();
    await s.mcpStatus({ reconnect: 'docs' });
    await s.mcpStatus({ toggle: { server: 'docs', enabled: false } });
    expect(fake.calls).toEqual(['reconnect:docs', 'status', 'toggle:docs:false', 'status']);
  });

  it('rejects when the CLI does, so the host can answer failed', async () => {
    const { s } = await open();
    fake.failStatus = 'cli gone';
    await expect(s.mcpStatus()).rejects.toThrow('cli gone');
  });
});

describe('session/mcp-status through the host', () => {
  function rig(session: Record<string, unknown> | null) {
    const sent: any[] = [];
    const proto = new ProtocolClient({ write: (l) => sent.push(JSON.parse(l)), batchMs: 1 });
    const provider: AgentProvider = { id: 'stub', kind: 'cli', detect: async () => ({ installed: true, auth: 'ok' }), capabilities: () => ({}) as never, listModels: async () => [], open: async () => ({ nativeId: 'n', prompt: () => {}, interrupt: async () => {}, answer: () => {}, close: async () => {}, ...session }) as never };
    new SidecarHost(proto, new Loader({ stub: async () => ({ default: provider }) }, ['stub']));
    const orig = proto.request.bind(proto);
    (proto as any).request = (type: string, body: unknown) => (type === 'slot/acquire' ? Promise.resolve({ leaseId: 'L9', ttlMs: 15000 }) : orig(type as never, body as never));
    const send = (id: number, type: string, body: unknown) => proto.receive(JSON.stringify({ v: 1, id, type, body }));
    const reply = (id: number) => sent.find((m) => m.id === id && m.type === 'reply')?.body;
    const start = { agentId: 'a1', provider: 'stub', role: { name: 'r', model: 'm', permission: 'ask' }, cwd: '/', env: {}, auth: { mode: 'subscription', key: null } };
    return { send, reply, start };
  }

  it('answers ok with the servers, passing reconnect and toggle through', async () => {
    const calls: unknown[] = [];
    const r = rig({ mcpStatus: async (op: unknown) => { calls.push(op); return [{ name: 'github', status: 'connected', tools: [] }]; } });
    r.send(1, 'session/start', r.start);
    await tick(20);
    r.send(2, 'session/mcp-status', { agentId: 'a1' });
    r.send(3, 'session/mcp-status', { agentId: 'a1', reconnect: 'github', toggle: { server: 'github', enabled: true } });
    await tick(20);
    expect(r.reply(2)).toEqual({ ok: true, servers: [{ name: 'github', status: 'connected', tools: [] }] });
    expect(calls).toEqual([{}, { reconnect: 'github', toggle: { server: 'github', enabled: true } }]);
  });

  it('answers noSession, unsupported and failed', async () => {
    const none = rig(null);
    none.send(1, 'session/mcp-status', { agentId: 'zz' });
    await tick();
    expect(none.reply(1)).toEqual({ error: 'noSession' });
    const plain = rig(null);
    plain.send(1, 'session/start', plain.start);
    await tick(20);
    plain.send(2, 'session/mcp-status', { agentId: 'a1' });
    await tick();
    expect(plain.reply(2)).toMatchObject({ error: 'unsupported' });
    const broken = rig({ mcpStatus: async () => { throw new Error('timeout: mcpServerStatus'); } });
    broken.send(1, 'session/start', broken.start);
    await tick(20);
    broken.send(2, 'session/mcp-status', { agentId: 'a1' });
    await tick();
    expect(broken.reply(2)).toEqual({ error: 'failed', detail: 'timeout: mcpServerStatus' });
  });
});
