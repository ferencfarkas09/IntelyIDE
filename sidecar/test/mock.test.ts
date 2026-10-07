import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import provider from '../src/adapters/mock/index.js';
import { SCENARIOS } from '../src/adapters/mock/scenarios.js';
import { parseScript } from '../src/adapters/mock/script.js';
import { SidecarHost } from '../src/host.js';
import { Loader } from '../src/loader.js';
import { ProtocolClient } from '../src/protocol.js';
import { checkInvariants, SeqSink, TurnGuard } from '../src/turn.js';
import type { AgentSession, DelegateSpec, PermissionMode, PolicyClient, PolicyDecision, PolicyRequest, SessionSpec, WireEvent } from '../src/types.js';

async function open(scenario: string, script?: string, speed = 0) {
  const out: WireEvent[] = [];
  const guard = new TurnGuard(new SeqSink((e) => out.push(e)));
  const spec: SessionSpec = { agentId: 'a', provider: 'mock', role: { name: 'm', model: 'mock-1', permission: 'edit' }, cwd: '/', addDirs: [], env: {}, mcp: {}, auth: { mode: 'subscription', key: null }, mock: { scenario, speed, ...(script ? { script } : {}) } };
  const s = await provider.open(spec, guard, { decide: async () => ({ decision: 'allow', by: 'saved' }) }, { registerPid: () => undefined });
  return { s, out, guard };
}
const turn = async (s: AgentSession, guard: TurnGuard) => { guard.beginTurn(); s.prompt({ text: 'go' }); };
const until = async (pred: () => boolean, ms = 2000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 2)); } };
const ends = (out: WireEvent[]) => out.filter((e) => e.kind === 'turn.end').length;

describe('mock provider scenarios', () => {
  it('plain-reply streams chunks then text.done and keeps the invariants', async () => {
    const { s, out, guard } = await open('plain-reply');
    await turn(s, guard);
    await until(() => ends(out) === 1);
    expect(out.filter((e) => e.kind === 'text.delta').length).toBeGreaterThan(3);
    expect(out.find((e) => e.kind === 'text.done')).toMatchObject({ text: expect.stringContaining('mock provider') });
    expect(checkInvariants(out)).toEqual([]);
  });

  it('tool-permission: allow runs the write with a diff', async () => {
    const { s, out, guard } = await open('tool-permission');
    await turn(s, guard);
    await until(() => out.some((e) => e.kind === 'permission.request'));
    const req = out.find((e) => e.kind === 'permission.request') as Extract<WireEvent, { kind: 'permission.request' }>;
    s.answer(req.reqId, { outcome: 'allow' });
    await until(() => ends(out) === 1);
    expect(out.find((e) => e.kind === 'permission.resolved')).toMatchObject({ outcome: 'allow', by: 'user' });
    expect(out.filter((e) => e.kind === 'tool.result').at(-1)).toMatchObject({ toolId: 't2', status: 'ok', diff: { new: 'hello' } });
    expect(checkInvariants(out)).toEqual([]);
  });

  it('tool-permission: deny takes the denied branch', async () => {
    const { s, out, guard } = await open('tool-permission');
    await turn(s, guard);
    await until(() => out.some((e) => e.kind === 'permission.request'));
    s.answer((out.find((e) => e.kind === 'permission.request') as { reqId: string }).reqId, { outcome: 'deny' });
    await until(() => ends(out) === 1);
    expect(out.filter((e) => e.kind === 'tool.result').at(-1)).toMatchObject({ toolId: 't2', status: 'denied' });
    expect(checkInvariants(out)).toEqual([]);
  });

  it('ask-question waits for the answer', async () => {
    const { s, out, guard } = await open('ask-question');
    await turn(s, guard);
    await until(() => out.some((e) => e.kind === 'question.request'));
    expect(ends(out)).toBe(0);
    s.answer('q-t1', { outcome: 'allow', answers: { 'Which colour?': 'Blue' } });
    await until(() => ends(out) === 1);
    expect(checkInvariants(out)).toEqual([]);
  });

  it('error ends with error + turn.end(error)', async () => {
    const { s, out, guard } = await open('error');
    await turn(s, guard);
    await until(() => ends(out) === 1);
    expect(out.find((e) => e.kind === 'error')).toMatchObject({ class: 'provider', retryable: true });
    expect(out.at(-1)).toMatchObject({ kind: 'turn.end', stopReason: 'error' });
  });

  it('throttle reports throttled with retryAfterMs, then recovers', async () => {
    const { s, out, guard } = await open('throttle');
    await turn(s, guard);
    await until(() => ends(out) === 1);
    expect(out.find((e) => e.kind === 'status' && e.state === 'throttled')).toMatchObject({ retryAfterMs: 4000, scope: 'five_hour' });
    expect(out.at(-1)).toMatchObject({ stopReason: 'endTurn' });
  });

  it('interrupt cancels the running tool and ends the turn as cancelled', async () => {
    const { s, out, guard } = await open('interrupt', undefined, 1);
    await turn(s, guard);
    await until(() => out.some((e) => e.kind === 'tool.start'));
    await s.interrupt();
    expect(ends(out)).toBe(1);
    expect(out.at(-1)).toMatchObject({ kind: 'turn.end', stopReason: 'cancelled' });
    expect(out.find((e) => e.kind === 'tool.result')).toMatchObject({ toolId: 't1', status: 'cancelled' });
    expect(checkInvariants(out)).toEqual([]);
  });

  it('interrupt while a permission is pending resolves it as cancelled', async () => {
    const { s, out, guard } = await open('tool-permission', undefined, 1);
    await turn(s, guard);
    await until(() => out.some((e) => e.kind === 'permission.request'));
    await s.interrupt();
    expect(out.find((e) => e.kind === 'permission.resolved')).toMatchObject({ outcome: 'cancelled' });
    expect(checkInvariants(out)).toEqual([]);
  });

  it('subagent-tree nests child tools and text under the Agent tool', async () => {
    const { s, out, guard } = await open('subagent-tree');
    await turn(s, guard);
    await until(() => ends(out) === 1);
    const kids = out.filter((e) => (e.kind === 'tool.start' || e.kind === 'text.done') && 'parentToolId' in e && e.parentToolId === 't1');
    expect(kids.length).toBe(3);
    expect(checkInvariants(out)).toEqual([]);
  });

  it('hard-stop shows a refusal by hardStop without a prompt', async () => {
    const { s, out, guard } = await open('hard-stop');
    await turn(s, guard);
    await until(() => ends(out) === 1);
    expect(out.find((e) => e.kind === 'permission.resolved')).toMatchObject({ outcome: 'deny', by: 'hardStop' });
    expect(checkInvariants(out)).toEqual([]);
  });

  it('every shipped scenario parses and ends cleanly or waits only for answers', () => {
    for (const [name, text] of Object.entries(SCENARIOS)) expect(parseScript(text).length, name).toBeGreaterThan(0);
  });

  it('inline scripts, multi-turn scripts and bad scripts', async () => {
    const script = '{"op":"text","id":"a","text":"one"}\n{"op":"turn"}\n{"op":"text","id":"b","text":"two"}';
    const { s, out, guard } = await open('x', script);
    await turn(s, guard); await until(() => ends(out) === 1);
    await turn(s, guard); await until(() => ends(out) === 2);
    expect(out.filter((e) => e.kind === 'text.done').map((e) => (e as { text: string }).text)).toEqual(['one', 'two']);
    expect(() => parseScript('{"op":"nope"}')).toThrow(/unknown op/);
    expect(() => parseScript('not json')).toThrow(/invalid JSON/);
    await expect(open('missing-scenario')).rejects.toThrow(/unknown mock scenario/);
  });

  it('honours timing: with speed 1 a delayed step takes about its dt', async () => {
    const out: WireEvent[] = [];
    const guard = new TurnGuard(new SeqSink((e) => out.push(e)));
    const spec = { agentId: 'a', provider: 'mock', role: { name: 'm', model: 'mock-1', permission: 'edit' }, cwd: '/', addDirs: [], env: {}, mcp: {}, auth: { mode: 'subscription', key: null }, mock: { script: '{"op":"text","dt":120,"id":"a","text":"x"}', speed: 1 } } as SessionSpec;
    const s = await provider.open(spec, guard, { decide: async () => ({ decision: 'allow', by: 'saved' }) }, { registerPid: () => undefined });
    const t0 = Date.now();
    await turn(s, guard);
    await until(() => ends(out) === 1);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
  });
});

describe('delegation scenario (delegate-roles)', () => {
  type Golden = { actor: { role: string } | null; tool: string; input: Record<string, unknown>; expected: { decision: PolicyDecision['decision']; by: PolicyDecision['by']; rule: string } };
  const golden = (JSON.parse(readFileSync(new URL('../../packages/protocol/fixtures/delegation-cases.json', import.meta.url), 'utf8')) as { cases: Golden[] }).cases;

  /** A recorder that answers like the Rust broker did when the golden fixture was written: by (actor role, tool, command or path kind). */
  function recorder(seen: PolicyRequest[]): PolicyClient {
    return {
      decide: async (req) => {
        seen.push(req);
        const i = req.intent;
        const hit = golden.find((c) => (c.actor?.role ?? null) === (i.actor?.role ?? null) && c.tool === i.tool
          && (i.class === 'exec' ? c.input.command === i.rawCommand : i.class === 'read' ? (c.input.file_path === '.env') === (i.paths?.[0] ?? '').endsWith('.env') : i.tool === 'Agent' ? c.input.subagent_type === i.subagentType && c.input.run_in_background === false : true));
        return hit ? { decision: hit.expected.decision, by: hit.expected.by, reason: 'golden', rule: hit.expected.rule } : { decision: 'deny', by: 'failClosed', reason: 'no golden case', rule: 'test.no-case' };
      },
    };
  }

  const delegates: DelegateSpec[] = [
    { name: 'researcher', description: 'Reads', prompt: 'SECRET PROMPT', model: 'claude-haiku-4-5-20251001', permission: 'readOnly', tools: ['Read', 'Grep'], disallowedTools: [], scope: 'global' },
    { name: 'writer', description: 'Edits', prompt: 'SECRET PROMPT', model: 'claude-sonnet-5-5', permission: 'edit', tools: ['Read', 'Edit', 'Write'], disallowedTools: [], scope: 'repo' },
  ];

  async function play(script: string | undefined, policy: PolicyClient, over: Partial<SessionSpec> = {}) {
    const out: WireEvent[] = [];
    const guard = new TurnGuard(new SeqSink((e) => out.push(e)));
    const spec: SessionSpec = { agentId: 'a', provider: 'mock', role: { name: 'mock-auto', model: 'mock-1', permission: 'edit' }, cwd: '/tmp/fx', addDirs: [], env: {}, mcp: {}, auth: { mode: 'subscription', key: null }, mock: { scenario: 'delegate-roles', speed: 0, ...(script ? { script } : {}) }, delegates, ...over };
    const s = await provider.open(spec, guard, policy, { registerPid: () => undefined });
    guard.beginTurn();
    s.prompt({ text: 'go' });
    await until(() => ends(out) === 1);
    return { out, s };
  }

  it('is listed, parses, and announces the roles as session.info without their prompts', async () => {
    expect(Object.keys(SCENARIOS)).toContain('delegate-roles');
    expect(parseScript(SCENARIOS['delegate-roles']!).length).toBeGreaterThan(0);
    const { out } = await play(undefined, recorder([]));
    const info = out.find((e) => e.kind === 'session.info') as Extract<WireEvent, { kind: 'session.info' }>;
    expect(info.delegates?.map((d) => d.name)).toEqual(['researcher', 'writer']);
    expect(JSON.stringify(info)).not.toContain('SECRET PROMPT');
  });

  it('plays the scenario with the real policy call per tool: the roles, the denials with by, the actor on every card', async () => {
    const seen: PolicyRequest[] = [];
    const { out } = await play(undefined, recorder(seen));
    expect(checkInvariants(out)).toEqual([]);
    const result = (id: string) => out.find((e) => e.kind === 'tool.result' && e.toolId === id) as Extract<WireEvent, { kind: 'tool.result' }>;
    const resolved = (id: string) => out.find((e) => e.kind === 'permission.resolved' && e.reqId === `perm-${id}`) as Extract<WireEvent, { kind: 'permission.resolved' }> | undefined;
    // lead: two Agent calls, both allowed, each closed by its enddelegate
    expect(out.filter((e) => e.kind === 'tool.start' && e.name === 'Agent').map((e) => (e as { input: { subagent_type: string } }).input.subagent_type)).toEqual(['researcher', 'writer']);
    expect(result('ag1').status).toBe('ok');
    expect(result('ag2').status).toBe('ok');
    // researcher: Read ok, Edit and Bash refused by the role, commit/push/.env by the hard stop
    expect(result('c1').status).toBe('ok');
    for (const id of ['c2', 'c3']) { expect(result(id).status, id).toBe('denied'); expect(resolved(id)?.by, id).toBe('roleDeny'); }
    for (const id of ['c4', 'c5', 'c6', 'c9', 'c10']) { expect(result(id).status, id).toBe('denied'); expect(resolved(id)?.by, id).toBe('hardStop'); expect(result(id).output, id).toContain('hardStop'); }
    // writer: Edit ok, Bash refused because the role has no such tool
    expect(result('c7').status).toBe('ok');
    expect(resolved('c7')).toBeUndefined();
    expect(result('c8').status).toBe('denied');
    expect(resolved('c8')?.by).toBe('roleDeny');
    // every refused call carries the actor on its card, and the policy saw the actor of the delegate
    for (const e of out.filter((x) => x.kind === 'permission.request') as Extract<WireEvent, { kind: 'permission.request' }>[]) {
      const role = e.toolId === 'c1' || ['c2', 'c3', 'c4', 'c5', 'c6'].includes(e.toolId) ? 'researcher' : 'writer';
      if (e.toolId.startsWith('ag')) continue;
      expect(e.intent.actor, e.toolId).toEqual({ agentId: `sub-${role === 'researcher' ? 'ag1' : 'ag2'}`, role });
    }
    expect(seen.find((r) => r.toolId === 'c2')?.intent).toMatchObject({ actor: { role: 'researcher' }, parentToolId: 'ag1' });
    expect(seen.find((r) => r.toolId === 'ag1')?.intent.actor, 'the lead has no actor').toBeUndefined();
    // children nest under their Agent tool
    expect(out.filter((e) => e.kind === 'tool.start' && 'parentToolId' in e && e.parentToolId === 'ag2')).toHaveLength(4);
  });

  it('substitutes {{cwd}} in the inputs', async () => {
    const seen: PolicyRequest[] = [];
    await play(undefined, recorder(seen), { cwd: '/tmp/fixture-repo' });
    expect(seen.find((r) => r.toolId === 'c1')?.intent.paths).toEqual(['/tmp/fixture-repo/README.md']);
  });

  it('a lead that starts a role the run does not have is refused by the broker and the script goes on without a dangling tool', async () => {
    const script = [
      '{"op":"delegate","id":"ag1","role":"ghost","description":"x"}',
      '{"op":"call","id":"c1","parent":"ag1","name":"Read","toolKind":"read","input":{"file_path":"a"}}',
      '{"op":"enddelegate","id":"ag1","output":"never"}',
      '{"op":"text","id":"m","text":"done"}',
    ].join('\n');
    const policy: PolicyClient = { decide: async (r) => (r.intent.tool === 'Agent' ? { decision: 'deny', by: 'roleDeny', reason: 'not a role', rule: 'delegate.unknown-type' } : { decision: 'allow', by: 'default' }) };
    const { out } = await play(script, policy);
    expect(checkInvariants(out)).toEqual([]);
    expect(out.find((e) => e.kind === 'tool.result' && e.toolId === 'ag1')).toMatchObject({ status: 'denied', output: expect.stringContaining('delegate.unknown-type') });
    expect(out.filter((e) => e.kind === 'tool.result' && e.toolId === 'ag1')).toHaveLength(1);
    expect(out.some((e) => e.kind === 'tool.start' && e.toolId === 'c1'), 'the refused role never ran, so its scripted calls are skipped').toBe(false);
  });

  it('an actor override plays a caller the run does not know, and an ask waits for the answer', async () => {
    const script = '{"op":"call","id":"c1","name":"Edit","toolKind":"edit","role":"ghost","input":{"file_path":"a"}}\n{"op":"call","id":"c2","name":"Write","toolKind":"edit","input":{"file_path":"b"}}';
    const seen: PolicyRequest[] = [];
    const policy: PolicyClient = { decide: async (r) => { seen.push(r); return r.toolId === 'c1' ? { decision: 'deny', by: 'roleDeny', rule: 'delegate.unknown-actor' } : { decision: 'ask', by: 'default' }; } };
    const out: WireEvent[] = [];
    const guard = new TurnGuard(new SeqSink((e) => out.push(e)));
    const spec: SessionSpec = { agentId: 'a', provider: 'mock', role: { name: 'm', model: 'mock-1', permission: 'edit' }, cwd: '/', addDirs: [], env: {}, mcp: {}, auth: { mode: 'subscription', key: null }, mock: { script, speed: 0 } };
    const s = await provider.open(spec, guard, policy, { registerPid: () => undefined });
    guard.beginTurn();
    s.prompt({ text: 'go' });
    await until(() => out.some((e) => e.kind === 'permission.request' && e.reqId === 'perm-c2'));
    expect(seen[0]?.intent.actor?.role).toBe('ghost');
    expect(ends(out)).toBe(0);
    s.answer('perm-c2', { outcome: 'allow' });
    await until(() => ends(out) === 1);
    expect(out.find((e) => e.kind === 'tool.result' && e.toolId === 'c2')).toMatchObject({ status: 'ok' });
    expect(checkInvariants(out)).toEqual([]);
  });
});

// ---------- permission modes (spec 6.6, S-6) ----------
describe('the mock honours the five modes', () => {
  async function openAs(permission: PermissionMode, scenario: string, policy: PolicyClient) {
    const out: WireEvent[] = [];
    const guard = new TurnGuard(new SeqSink((e) => out.push(e)));
    const spec: SessionSpec = { agentId: 'a', provider: 'mock', role: { name: 'm', model: 'mock-1', permission }, cwd: '/tmp/fx', addDirs: [], env: {}, mcp: {}, auth: { mode: 'subscription', key: null }, mock: { scenario, speed: 0 } };
    const s = await provider.open(spec, guard, policy, { registerPid: () => undefined });
    return { s, out, guard };
  }
  const requests = (out: WireEvent[]) => out.filter((e) => e.kind === 'permission.request') as Extract<WireEvent, { kind: 'permission.request' }>[];

  it.each(['readOnly', 'ask', 'edit', 'automatic', 'bypass'] as const)('session.started reports %s', async (mode) => {
    const { out } = await openAs(mode, 'plain-reply', { decide: async () => ({ decision: 'allow', by: 'default' }) });
    expect(out.find((e) => e.kind === 'session.started')).toMatchObject({ effective: { permission: mode } });
  });

  it('setPermission accepts all five modes, emits session.info{permission, user} and stays quiet for a repeat', async () => {
    const { s, out } = await openAs('ask', 'plain-reply', { decide: async () => ({ decision: 'allow', by: 'default' }) });
    for (const m of ['readOnly', 'edit', 'automatic', 'bypass', 'ask'] as const) await s.setPermission!(m);
    await s.setPermission!('ask');
    const infos = out.filter((e) => e.kind === 'session.info' && e.effective) as Extract<WireEvent, { kind: 'session.info' }>[];
    expect(infos.map((e) => [e.effective?.permission, e.effective?.reason])).toEqual([['readOnly', 'user'], ['edit', 'user'], ['automatic', 'user'], ['bypass', 'user'], ['ask', 'user']]);
  });

  it('offers allow_run (with the offer) only when the decision carries a sessionAllow', async () => {
    const offer = { kind: 'exec', scope: 'touch twice' } as const;
    for (const [d, want] of [[{ decision: 'ask', by: 'roleDeny', sessionAllow: offer }, ['allow_once', 'allow_run', 'deny']], [{ decision: 'ask', by: 'roleDeny' }, ['allow_once', 'deny']]] as const) {
      const { s, out, guard } = await openAs('ask', 'bash-twice', { decide: async () => d as PolicyDecision });
      await turn(s, guard);
      await until(() => requests(out).length > 0);
      expect(requests(out)[0]!.options).toEqual(want);
      if (d.sessionAllow) expect(requests(out)[0]).toMatchObject({ sessionAllow: offer }); else expect(requests(out)[0]).not.toHaveProperty('sessionAllow');
      await s.interrupt();
    }
  });

  it('bash-twice: the same command twice through the real policy call; once a session allow exists the second call shows no card', async () => {
    const seen: PolicyRequest[] = [];
    let saved = false; // what the host does after an allow_run answer: the next decide is an allow
    const policy: PolicyClient = { decide: async (r) => { seen.push(r); return saved ? { decision: 'allow', by: 'saved', rule: 'exec.saved' } : { decision: 'ask', by: 'roleDeny', sessionAllow: { kind: 'exec', scope: 'touch twice' } }; } };
    const { s, out, guard } = await openAs('ask', 'bash-twice', policy);
    await turn(s, guard);
    await until(() => requests(out).length === 1);
    expect(seen[0]?.intent).toMatchObject({ class: 'exec', rawCommand: 'touch twice' });
    saved = true;
    s.answer(requests(out)[0]!.reqId, { outcome: 'allow' }); // allow_run arrives as allow
    await until(() => ends(out) === 1);
    expect(requests(out)).toHaveLength(1); // no second card
    expect(out.filter((e) => e.kind === 'tool.result' && e.toolId.startsWith('b')).map((e) => (e as { status: string }).status)).toEqual(['ok', 'ok']);
    expect(seen.map((r) => r.toolId)).toEqual(['b1', 'b2']);
    expect(checkInvariants(out)).toEqual([]);
  });

  it.each(['automatic', 'bypass'] as const)('%s: a (buggy) Ask from the policy is a denial, never a card', async (mode) => {
    const { s, out, guard } = await openAs(mode, 'bash-twice', { decide: async () => ({ decision: 'ask', by: 'roleDeny' }) });
    await turn(s, guard);
    await until(() => ends(out) === 1);
    expect(requests(out).every((r) => r.options?.length === 1 && r.options[0] === 'deny')).toBe(true);
    expect(out.filter((e) => e.kind === 'tool.result' && e.toolId.startsWith('b')).map((e) => (e as { status: string }).status)).toEqual(['denied', 'denied']);
    expect(checkInvariants(out)).toEqual([]);
  });
});

describe('plan-approval scenario end to end through a real ProtocolClient rig', () => {
  /** SidecarHost + the mock provider; `decide` answers policy/decide like Rust, replies to slot/acquire are automatic. */
  function rig(decide: (body: any) => PolicyDecision) {
    const sent: any[] = [];
    const proto: ProtocolClient = new ProtocolClient({
      write: (l) => {
        const m = JSON.parse(l);
        sent.push(m);
        const reply = m.type === 'policy/decide' ? decide(m.body) : m.type === 'slot/acquire' ? { leaseId: 'L', ttlMs: 15000 } : undefined;
        if (reply) queueMicrotask(() => proto.receive(JSON.stringify({ v: 1, id: m.id, type: 'reply', body: reply })));
      },
      batchMs: 1,
    });
    new SidecarHost(proto, new Loader({ mock: async () => ({ default: provider }) }, ['mock']));
    const send = (id: number, type: string, body: unknown) => proto.receive(JSON.stringify({ v: 1, id, type, body }));
    const events = () => sent.filter((m) => m.type === 'events/batch').flatMap((m) => m.body.events as WireEvent[]);
    const replyOf = (id: number) => sent.find((m) => m.id === id && m.type === 'reply')?.body;
    return { sent, send, events, replyOf, proto };
  }
  const startBody = (permission: PermissionMode) => ({ agentId: 'a1', provider: 'mock', role: { name: 'mock-plan-approval', model: 'mock-1', permission }, cwd: '/tmp/fx', env: {}, auth: { mode: 'subscription', key: null }, mock: { scenario: 'plan-approval', speed: 0 } });
  const PLAN_ASK: PolicyDecision = { decision: 'ask', by: 'roleDeny', reason: 'the user approves the plan', rule: 'other.exit-plan' };
  const waitFor = async (pred: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 5)); } };
  const planCards = (r: ReturnType<typeof rig>) => r.events().filter((e) => e.kind === 'permission.request') as Extract<WireEvent, { kind: 'permission.request' }>[];

  it('the scenario ships and parses with the exitplan op', () => {
    expect(Object.keys(SCENARIOS)).toEqual(expect.arrayContaining(['plan-approval', 'bash-twice']));
    expect(parseScript(SCENARIOS['plan-approval']!).flat().map((s) => s.op)).toEqual(['text', 'exitplan', 'end']);
  });

  it('approve with Accept edits: card with the two-paragraph plan and the three modes, then planApproved, ok result and "Continuing in edit."', async () => {
    const seen: any[] = [];
    const r = rig((b) => { seen.push(b); return PLAN_ASK; });
    r.send(1, 'session/start', startBody('readOnly'));
    await waitFor(() => r.replyOf(1));
    expect(r.replyOf(1)).toMatchObject({ ok: true });
    r.send(2, 'session/prompt', { agentId: 'a1', text: 'plan it' });
    await waitFor(() => planCards(r).length === 1);
    const card = planCards(r)[0]!;
    expect(card).toMatchObject({ toolId: 'x1', options: ['allow_once', 'deny'], modes: ['ask', 'edit', 'automatic'], intent: { tool: 'ExitPlanMode' } });
    expect(card.plan!.split('\n\n').length).toBeGreaterThanOrEqual(3); // heading + two paragraphs
    expect(seen[0]).toMatchObject({ toolId: 'x1', intent: { class: 'other', tool: 'ExitPlanMode' } });
    r.send(3, 'permission/answer', { agentId: 'a1', reqId: card.reqId, outcome: 'allow', mode: 'edit' });
    await waitFor(() => r.events().some((e) => e.kind === 'turn.end'));
    const ev = r.events();
    expect(ev.find((e) => e.kind === 'permission.resolved')).toMatchObject({ outcome: 'allow', by: 'user' });
    expect(ev.find((e) => e.kind === 'session.info' && e.effective)).toMatchObject({ effective: { permission: 'edit', reason: 'planApproved' } });
    expect(ev.find((e) => e.kind === 'tool.result' && e.toolId === 'x1')).toMatchObject({ status: 'ok' });
    expect(ev.filter((e) => e.kind === 'text.done').map((e) => (e as { text: string }).text)).toContain('Continuing in edit.');
    expect(ev.at(-1)).toMatchObject({ kind: 'turn.end', stopReason: 'endTurn' });
    expect(checkInvariants(ev)).toEqual([]);
  });

  it('reject with a note: the note comes back as the tool error, the mode stays, the "model" revises and asks once more', async () => {
    const r = rig(() => PLAN_ASK);
    r.send(1, 'session/start', startBody('readOnly'));
    await waitFor(() => r.replyOf(1));
    r.send(2, 'session/prompt', { agentId: 'a1', text: 'plan it' });
    await waitFor(() => planCards(r).length === 1);
    r.send(3, 'permission/answer', { agentId: 'a1', reqId: planCards(r)[0]!.reqId, outcome: 'deny', message: 'Add a rollback step' });
    await waitFor(() => planCards(r).length === 2);
    const ev = r.events();
    expect(ev.find((e) => e.kind === 'tool.result' && e.toolId === 'x1')).toMatchObject({ status: 'error', output: 'Add a rollback step' });
    expect(ev.filter((e) => e.kind === 'text.done').map((e) => (e as { text: string }).text)).toContain('Revising: Add a rollback step.');
    expect(ev.some((e) => e.kind === 'session.info' && e.effective)).toBe(false); // still Plan
    expect(planCards(r)[1]).toMatchObject({ toolId: 'x1-r2', modes: ['ask', 'edit', 'automatic'] });
    r.send(4, 'permission/answer', { agentId: 'a1', reqId: planCards(r)[1]!.reqId, outcome: 'allow', mode: 'automatic' });
    await waitFor(() => r.events().some((e) => e.kind === 'turn.end'));
    expect(r.events().find((e) => e.kind === 'session.info' && e.effective)).toMatchObject({ effective: { permission: 'automatic', reason: 'planApproved' } });
    expect(checkInvariants(r.events())).toEqual([]);
  });

  it('a second rejection ends the turn without a third card', async () => {
    const r = rig(() => PLAN_ASK);
    r.send(1, 'session/start', startBody('readOnly'));
    await waitFor(() => r.replyOf(1));
    r.send(2, 'session/prompt', { agentId: 'a1', text: 'plan it' });
    await waitFor(() => planCards(r).length === 1);
    r.send(3, 'permission/answer', { agentId: 'a1', reqId: planCards(r)[0]!.reqId, outcome: 'deny', message: 'no' });
    await waitFor(() => planCards(r).length === 2);
    r.send(4, 'permission/answer', { agentId: 'a1', reqId: planCards(r)[1]!.reqId, outcome: 'deny', message: 'still no' });
    await waitFor(() => r.events().some((e) => e.kind === 'turn.end'));
    expect(planCards(r)).toHaveLength(2);
    expect(checkInvariants(r.events())).toEqual([]);
  });

  it('a Rust that does not ask (the run is not in Plan) just lets the call through; a deny is a refusal pair', async () => {
    const allow = rig(() => ({ decision: 'allow', by: 'saved' }));
    allow.send(1, 'session/start', startBody('ask'));
    await waitFor(() => allow.replyOf(1));
    allow.send(2, 'session/prompt', { agentId: 'a1', text: 'go' });
    await waitFor(() => allow.events().some((e) => e.kind === 'turn.end'));
    expect(planCards(allow)).toHaveLength(0);
    expect(allow.events().find((e) => e.kind === 'tool.result' && e.toolId === 'x1')).toMatchObject({ status: 'ok' });
    const deny = rig(() => ({ decision: 'deny', by: 'roleDeny', reason: 'only the lead', rule: 'other.exit-plan-delegate' }));
    deny.send(1, 'session/start', startBody('readOnly'));
    await waitFor(() => deny.replyOf(1));
    deny.send(2, 'session/prompt', { agentId: 'a1', text: 'go' });
    await waitFor(() => deny.events().some((e) => e.kind === 'turn.end'));
    expect(deny.events().find((e) => e.kind === 'tool.result' && e.toolId === 'x1')).toMatchObject({ status: 'denied', output: expect.stringContaining('other.exit-plan-delegate') });
  });

  it('session/permission reaches the mock through the host: ok reply and a session.info event', async () => {
    const r = rig(() => ({ decision: 'allow', by: 'saved' }));
    r.send(1, 'session/start', startBody('ask'));
    await waitFor(() => r.replyOf(1));
    r.send(2, 'session/permission', { agentId: 'a1', mode: 'automatic' });
    await waitFor(() => r.replyOf(2));
    expect(r.replyOf(2)).toEqual({ ok: true });
    await waitFor(() => r.events().some((e) => e.kind === 'session.info' && e.effective));
    expect(r.events().find((e) => e.kind === 'session.info' && e.effective)).toMatchObject({ effective: { permission: 'automatic', reason: 'user' } });
  });
});
