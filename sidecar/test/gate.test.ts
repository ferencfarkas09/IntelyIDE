// PreToolUse hook + canUseTool: policy/decide is asked FIRST and anything but a clean reply is a deny.
import { describe, expect, it } from 'vitest';
import { CLI_BENIGN_REASONS } from '../src/adapters/claude-sdk/cli-prompts.js';
import { DENY_MARK, PLAN_REJECT_DEFAULT, ToolGate } from '../src/adapters/claude-sdk/gate.js';
import { PLAN_MAX_BYTES } from '../src/permission-options.js';
import { ProtocolClient } from '../src/protocol.js';
import { checkInvariants, SeqSink, TurnGuard } from '../src/turn.js';
import type { PermissionMode, PolicyClient, PolicyDecision, WireEvent } from '../src/types.js';

/** `mode` is the IDE mode the session holds; `holder.mode` can be changed by a test like a live switch does, `noted` records the plan-approval callbacks. */
function rig(policy: PolicyClient, o: { mode?: PermissionMode; lastText?: string; delegating?: boolean; cwd?: string; runDirs?: string[] } = {}) {
  const out: WireEvent[] = [];
  const guard = new TurnGuard(new SeqSink((e) => out.push(e)));
  guard.beginTurn();
  const denied = new Set<string>();
  const holder = { mode: o.mode ?? ('ask' as PermissionMode), text: o.lastText };
  const noted: PermissionMode[] = [];
  const gate: ToolGate = new ToolGate({
    agentId: 'a1', provider: 'claude', policy, sink: guard, denied, delegating: o.delegating, cwd: o.cwd, runDirs: o.runDirs,
    mode: () => holder.mode, lastText: () => holder.text,
    noteMode: (m) => { holder.mode = m; noted.push(m); gate.bumpEpoch(); }, // like ClaudeSession.noteMode
  });
  return { out, guard, gate, denied, holder, noted };
}
const kinds = (out: WireEvent[], kind: string) => out.filter((e) => e.kind === kind) as any[];
const hook = (g: ToolGate, tool: string, input: unknown, id = 't1', extra: Record<string, unknown> = {}) =>
  g.preToolUse({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: id, ...extra } as never, id, { signal: new AbortController().signal });
const decisionOf = (r: unknown) => (r as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;
const fixed = (d: PolicyDecision): PolicyClient => ({ decide: async () => d });

describe('PreToolUse hook', () => {
  it('asks policy first with the raw command and denies on a hard stop', async () => {
    const seen: unknown[] = [];
    const { gate, out, denied } = rig({ decide: async (r) => { seen.push(r); return { decision: 'deny', by: 'hardStop', reason: 'git push is human-only' }; } });
    const r = await hook(gate, 'Bash', { command: '/usr/bin/git push origin HEAD' });
    expect(seen[0]).toMatchObject({ agentId: 'a1', toolId: 't1', provider: 'claude', intent: { class: 'exec', rawCommand: '/usr/bin/git push origin HEAD' } });
    expect(decisionOf(r)).toMatchObject({ permissionDecision: 'deny' });
    expect(decisionOf(r)?.permissionDecisionReason).toContain(DENY_MARK);
    expect(denied.has('t1')).toBe(true);
    expect(out.map((e) => e.kind)).toEqual(['permission.request', 'permission.resolved']);
    expect(out[1]).toMatchObject({ outcome: 'deny', by: 'hardStop' });
  });

  it('lets an allowed tool through to the CLI rules (no explicit allow)', async () => {
    const { gate } = rig(fixed({ decision: 'allow', by: 'saved' }));
    expect(await hook(gate, 'Read', { file_path: '/r/a' })).toEqual({ continue: true });
  });

  it('forces the prompt for "ask"', async () => {
    const { gate } = rig(fixed({ decision: 'ask', by: 'roleDeny' }));
    expect(decisionOf(await hook(gate, 'Write', { file_path: '/r/a' }))).toMatchObject({ permissionDecision: 'ask' });
  });

  it('denies when policy throws, returns junk, or is unreachable', async () => {
    for (const policy of [
      { decide: async () => { throw new Error('boom'); } },
      { decide: async () => ({ nope: 1 }) as never },
      { decide: async () => null as never },
      { decide: async () => ({ decision: 'allow-ish', by: 'x' }) as never },
    ] as PolicyClient[]) {
      const { gate } = rig(policy);
      const r = decisionOf(await hook(gate, 'Bash', { command: 'ls' }));
      expect(r?.permissionDecision).toBe('deny');
      expect(r?.permissionDecisionReason).toContain('failClosed');
    }
  });

  it('with the real protocol client: silent host, malformed reply and a closed pipe all deny', async () => {
    const silent = new ProtocolClient({ write: () => undefined, policyTimeoutMs: 30 });
    expect(decisionOf(await hook(rig(silent).gate, 'Bash', { command: 'ls' }))?.permissionDecision).toBe('deny');

    const sent: any[] = [];
    const bad = new ProtocolClient({ write: (l) => sent.push(JSON.parse(l)) });
    const p = hook(rig(bad).gate, 'Bash', { command: 'ls' });
    await new Promise((r) => setTimeout(r, 5));
    bad.receive(JSON.stringify({ v: 1, id: sent[0].id, type: 'reply', body: { decision: 'allow' } }));
    expect(decisionOf(await p)?.permissionDecision).toBe('deny');

    const dying = new ProtocolClient({ write: () => undefined });
    const q = hook(rig(dying).gate, 'Bash', { command: 'ls' });
    dying.close(); // "kill the Rust side mid-request"
    expect(decisionOf(await q)?.permissionDecision).toBe('deny');
  });

  it('ignores other hook events', async () => {
    const { gate } = rig(fixed({ decision: 'deny', by: 'hardStop' }));
    expect(await gate.preToolUse({ hook_event_name: 'Stop' } as never, undefined, { signal: new AbortController().signal })).toEqual({ continue: true });
  });
});

describe('canUseTool', () => {
  const opts = (id: string, signal = new AbortController().signal) => ({ signal, toolUseID: id }) as never;

  it('prompts the user for "ask", resolves allow and emits the pair', async () => {
    const { gate, out } = rig(fixed({ decision: 'ask', by: 'roleDeny' }));
    const p = gate.canUseTool('Write', { file_path: '/r/a', content: 'x' }, opts('t2'));
    await new Promise((r) => setTimeout(r, 5));
    expect(out.find((e) => e.kind === 'permission.request')).toMatchObject({ reqId: 'perm-t2', options: ['allow_once', 'deny'] });
    gate.answer('perm-t2', { outcome: 'allow' });
    expect(await p).toMatchObject({ behavior: 'allow', updatedInput: { file_path: '/r/a' } });
    expect(out.find((e) => e.kind === 'permission.resolved')).toMatchObject({ outcome: 'allow', by: 'user' });
    expect(checkInvariants(out)).toEqual(['turn never ended']);
  });

  it('denies with the user message and marks the tool denied', async () => {
    const { gate, denied } = rig(fixed({ decision: 'ask', by: 'roleDeny' }));
    const p = gate.canUseTool('Write', {}, opts('t3'));
    await new Promise((r) => setTimeout(r, 5));
    gate.answer('perm-t3', { outcome: 'deny', message: 'no thanks' });
    expect(await p).toMatchObject({ behavior: 'deny', message: 'no thanks' });
    expect(denied.has('t3')).toBe(true);
  });

  it('cancels pending approvals on abort and on cancelPending', async () => {
    const { gate, out } = rig(fixed({ decision: 'ask', by: 'roleDeny' }));
    const ac = new AbortController();
    const a = gate.canUseTool('Write', {}, opts('t4', ac.signal));
    const b = gate.canUseTool('Bash', { command: 'ls' }, opts('t5'));
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    expect(await a).toMatchObject({ behavior: 'deny', message: 'cancelled' });
    gate.cancelPending('cancelled');
    expect(await b).toMatchObject({ behavior: 'deny' });
    expect(out.filter((e) => e.kind === 'permission.resolved').map((e) => (e as { outcome: string }).outcome)).toEqual(['cancelled', 'cancelled']);
  });

  it('reuses the decision the hook already got (one policy call per tool)', async () => {
    let calls = 0;
    const { gate } = rig({ decide: async () => { calls++; return { decision: 'allow', by: 'saved' }; } });
    await hook(gate, 'Read', { file_path: '/r/a' }, 't6');
    expect(await gate.canUseTool('Read', { file_path: '/r/a' }, opts('t6'))).toMatchObject({ behavior: 'allow' });
    expect(calls).toBe(1);
  });

  it('denies a tool the hook never saw when policy says deny (defence in depth)', async () => {
    const { gate } = rig(fixed({ decision: 'deny', by: 'roleDeny', reason: 'readOnly role' }));
    expect(await gate.canUseTool('Write', {}, opts('t7'))).toMatchObject({ behavior: 'deny', message: expect.stringContaining('roleDeny') });
  });

  it('AskUserQuestion becomes question.request and returns the answers as updatedInput', async () => {
    const { gate, out } = rig(fixed({ decision: 'allow', by: 'saved' }));
    const input = { questions: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue', description: 'calm' }] }] };
    const p = gate.canUseTool('AskUserQuestion', input, opts('t8'));
    await new Promise((r) => setTimeout(r, 5));
    expect(out.find((e) => e.kind === 'question.request')).toMatchObject({ reqId: 'q-t8', prompt: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue', description: 'calm' }] });
    gate.answer('q-t8', { outcome: 'allow', answers: { 'Which colour?': 'Blue' } });
    expect(await p).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which colour?': 'Blue' } } });
  });

  it('asks every question of a call in turn and merges the answers, stopping at the first one the user declines', async () => {
    const { gate, out } = rig(fixed({ decision: 'allow', by: 'saved' }));
    const input = { questions: [{ question: 'Which colour?', options: [{ label: 'Red' }] }, { question: 'Which size?', options: [{ label: 'S' }, { label: 'L' }] }] };
    const p = gate.canUseTool('AskUserQuestion', input, opts('t9'));
    await new Promise((r) => setTimeout(r, 5));
    expect(kinds(out, 'question.request').map((e) => e.reqId)).toEqual(['q-t9-0']);
    gate.answer('q-t9-0', { outcome: 'allow', answers: { 'Which colour?': 'Red' } });
    await new Promise((r) => setTimeout(r, 5));
    expect(kinds(out, 'question.request').map((e) => [e.reqId, e.prompt])).toEqual([['q-t9-0', 'Which colour?'], ['q-t9-1', 'Which size?']]);
    gate.answer('q-t9-1', { outcome: 'allow', answers: { 'Which size?': 'L' } });
    expect(await p).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which colour?': 'Red', 'Which size?': 'L' } } });

    const q = gate.canUseTool('AskUserQuestion', input, opts('t10'));
    await new Promise((r) => setTimeout(r, 5));
    gate.answer('q-t10-0', { outcome: 'deny', message: 'not now' });
    expect(await q).toMatchObject({ behavior: 'deny', message: 'not now' });
    expect(kinds(out, 'question.request').filter((e) => String(e.reqId).startsWith('q-t10'))).toHaveLength(1);
  });
});

// A sub-agent that runs out of turns reports no SubagentStop: the lead must not stay an "unknown actor" for the rest of the run.
describe('sub-agent bookkeeping', () => {
  const start = (g: ToolGate, id = 'sa1', type = 'researcher') => g.subagentStart({ hook_event_name: 'SubagentStart', agent_id: id, agent_type: type } as never, undefined, { signal: new AbortController().signal });
  const policySeeing = (seen: any[]): PolicyClient => ({ decide: async (r) => { seen.push(r); return { decision: 'allow', by: 'saved' }; } });
  const SPAWN = { subagent_type: 'researcher', prompt: 'look', description: 'look' };

  it('judges a call without agent_id as an unknown actor only while an Agent call is open, then as the lead again', async () => {
    const seen: any[] = [];
    const { gate } = rig(policySeeing(seen), { delegating: true });
    await hook(gate, 'Agent', SPAWN, 'agent1');
    await start(gate);
    await hook(gate, 'Bash', { command: 'ls' }, 'b1');
    expect(seen[1].intent.actor).toMatchObject({ role: '?' });
    gate.toolResult('agent1'); // the researcher ran out of turns: its result reaches the lead, SubagentStop never came
    await hook(gate, 'Bash', { command: 'ls' }, 'b2');
    expect(seen[2].intent.actor).toBeUndefined();
  });

  it('names a sub-agent call that carries its agent_id, and keeps the others open until the last Agent call returned', async () => {
    const seen: any[] = [];
    const { gate } = rig(policySeeing(seen), { delegating: true });
    await hook(gate, 'Agent', SPAWN, 'agent1');
    await hook(gate, 'Agent', { ...SPAWN, subagent_type: 'writer' }, 'agent2');
    await start(gate, 'sa1', 'researcher');
    await start(gate, 'sa2', 'writer');
    await hook(gate, 'Read', { file_path: '/r/a' }, 'r1', { agent_id: 'sa1', agent_type: 'researcher' });
    expect(seen.at(-1).intent.actor).toMatchObject({ agentId: 'sa1', role: 'researcher' });
    gate.toolResult('agent1');
    await hook(gate, 'Bash', { command: 'ls' }, 'b1'); // agent2 is still running: no agent_id is still not "the lead"
    expect(seen.at(-1).intent.actor).toMatchObject({ role: '?' });
    gate.toolResult('agent2');
    await hook(gate, 'Bash', { command: 'ls' }, 'b2');
    expect(seen.at(-1).intent.actor).toBeUndefined();
  });

  it('the end of the turn clears whatever is left, and an Agent call that was denied never counts as open', async () => {
    const seen: any[] = [];
    const { gate } = rig(policySeeing(seen), { delegating: true });
    await hook(gate, 'Agent', SPAWN, 'agent1');
    await start(gate);
    gate.turnEnded();
    await hook(gate, 'Bash', { command: 'ls' }, 'b1');
    expect(seen.at(-1).intent.actor).toBeUndefined();

    const deny = rig({ decide: async (r) => { seen.push(r); return r.intent.tool === 'Agent' ? { decision: 'deny', by: 'roleDeny', reason: 'no' } : { decision: 'allow', by: 'saved' }; } }, { delegating: true });
    await hook(deny.gate, 'Agent', SPAWN, 'agent9');
    await start(deny.gate, 'sa9');
    await hook(deny.gate, 'Bash', { command: 'ls' }, 'b9');
    expect(seen.at(-1).intent.actor).toBeUndefined();
  });
  // Live (jf): two Agent calls in ONE lead message. The hook of the second one fires after the first sub-agent started, carries no
  // agent_id (it is the lead) and was refused as `delegate.unknown-actor`.
  it('a parallel call of the lead (its tool_use came in a lead message) stays the lead while a sibling sub-agent already runs', async () => {
    const seen: any[] = [];
    const { gate } = rig(policySeeing(seen), { delegating: true });
    for (const id of ['agent1', 'agent2', 'r1']) gate.noteLeadToolUse(id);
    await hook(gate, 'Agent', SPAWN, 'agent1');
    await start(gate, 'sa1', 'researcher'); // the first sub-agent runs before the hook of the second call
    await hook(gate, 'Agent', { ...SPAWN, subagent_type: 'writer' }, 'agent2');
    expect(seen.at(-1).intent.actor).toBeUndefined();
    await hook(gate, 'Read', { file_path: '/r/a' }, 'r1');
    expect(seen.at(-1).intent.actor).toBeUndefined();
    await hook(gate, 'Bash', { command: 'ls' }, 'b1'); // nothing says this one is the lead's: it stays an unknown actor
    expect(seen.at(-1).intent.actor).toMatchObject({ role: '?' });
  });

  it('a tool_use that was seen inside a sub-agent is never taken for the lead, whatever else was noted', async () => {
    const seen: any[] = [];
    const { gate } = rig(policySeeing(seen), { delegating: true });
    await hook(gate, 'Agent', SPAWN, 'agent1');
    await start(gate);
    gate.noteLeadToolUse('x1');
    gate.noteSubagentToolUse('x1');
    await hook(gate, 'Bash', { command: 'ls' }, 'x1');
    expect(seen.at(-1).intent.actor).toMatchObject({ role: '?' });
  });
});

// The CLI backgrounds an Agent call by default (the lead ends its turn, the sub-agent works on outside every turn: the run reads Done and
// Stop is a no-op). Every allowed Agent call is rewritten to the foreground, in a run without delegates too.
describe('Agent calls run in the foreground', () => {
  const EXPLORE = { subagent_type: 'Explore', prompt: 'look', description: 'look', model: 'haiku' };

  it('a run without delegates: run_in_background:false is added and nothing else of the call changes (hook and canUseTool)', async () => {
    const { gate } = rig(fixed({ decision: 'allow', by: 'saved' }));
    const r = await hook(gate, 'Agent', EXPLORE, 'ag1');
    expect(decisionOf(r)).toMatchObject({ permissionDecision: 'allow' });
    expect((r as { hookSpecificOutput: { updatedInput: unknown } }).hookSpecificOutput.updatedInput).toEqual({ ...EXPLORE, run_in_background: false });
    expect(await gate.canUseTool('Task', EXPLORE, cuOpts('ag2'))).toMatchObject({ behavior: 'allow', updatedInput: { ...EXPLORE, run_in_background: false } });
  });

  it('a run with delegates keeps the stricter rewrite (the role decides the model, no worktree or team)', async () => {
    const { gate } = rig(fixed({ decision: 'allow', by: 'saved' }), { delegating: true });
    const r = await hook(gate, 'Agent', { ...EXPLORE, isolation: 'worktree', run_in_background: true }, 'ag3');
    expect((r as { hookSpecificOutput: { updatedInput: unknown } }).hookSpecificOutput.updatedInput).toEqual({ subagent_type: 'Explore', prompt: 'look', description: 'look', run_in_background: false });
  });

  it('other tools are never rewritten', async () => {
    const { gate } = rig(fixed({ decision: 'allow', by: 'saved' }));
    expect(await hook(gate, 'Read', { file_path: '/r/a' })).toEqual({ continue: true });
    expect(await gate.canUseTool('Bash', { command: 'ls' }, cuOpts('b1'))).toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
  });

});

// ---------- permission-modes spec 6.3 ----------
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const cuOpts = (id: string, extra: Record<string, unknown> = {}) => ({ signal: new AbortController().signal, toolUseID: id, ...extra }) as never;
const ASK: PolicyDecision = { decision: 'ask', by: 'roleDeny', reason: 'asks' };
const ALLOW: PolicyDecision = { decision: 'allow', by: 'saved' };

describe('permission options: allow_run next to allow_once and deny (6.3 item 2)', () => {
  it('offers the three buttons and carries the offer when Rust attached a sessionAllow', async () => {
    const offer = { kind: 'exec', scope: 'git status' } as const;
    const { gate, out } = rig(fixed({ decision: 'ask', by: 'roleDeny', sessionAllow: offer }));
    const p = gate.canUseTool('Bash', { command: 'git status' }, cuOpts('o1'));
    await tick();
    expect(kinds(out, 'permission.request')[0]).toMatchObject({ reqId: 'perm-o1', options: ['allow_once', 'allow_run', 'deny'], sessionAllow: offer });
    gate.answer('perm-o1', { outcome: 'allow' }); // allow_once and allow_run both arrive as allow: the session scope lives in the host
    expect(await p).toMatchObject({ behavior: 'allow' });
  });
  it('offers only allow_once and deny, and no sessionAllow key, when Rust attached none (also an explicit null)', async () => {
    for (const d of [ASK, { ...ASK, sessionAllow: null }]) {
      const { gate, out } = rig(fixed(d));
      void gate.canUseTool('Write', { file_path: '/r/a' }, cuOpts('o2'));
      await tick();
      const req = kinds(out, 'permission.request')[0];
      expect(req.options).toEqual(['allow_once', 'deny']);
      expect(req).not.toHaveProperty('sessionAllow');
    }
  });
  it('the audit pair of a refusal keeps options [deny]', async () => {
    const { gate, out } = rig(fixed({ decision: 'deny', by: 'hardStop', reason: 'no', sessionAllow: { kind: 'exec', scope: 'x' } }));
    await hook(gate, 'Bash', { command: 'git push' });
    expect(kinds(out, 'permission.request')[0].options).toEqual(['deny']);
  });
});

describe('unattended guard (6.3 item 3)', () => {
  it.each(['automatic', 'bypass'] as const)('%s: an Ask is a denial with the internal-error text, never a card, and one policy error per session', async (mode) => {
    const { gate, out, denied } = rig(fixed(ASK), { mode });
    const r = decisionOf(await hook(gate, 'Bash', { command: 'make' }, 'u1'));
    expect(r?.permissionDecision).toBe('deny');
    expect(r?.permissionDecisionReason).toContain(`${DENY_MARK}: the policy asked in an unattended mode (internal error)`);
    expect(r?.permissionDecisionReason).toContain('failClosed, policy.ask-in-unattended');
    expect(denied.has('u1')).toBe(true);
    const again = await gate.canUseTool('Bash', { command: 'make' }, cuOpts('u2'));
    expect(again).toMatchObject({ behavior: 'deny', message: expect.stringContaining('policy.ask-in-unattended') });
    expect(kinds(out, 'permission.request').every((e) => e.options.length === 1 && e.options[0] === 'deny')).toBe(true); // audit pairs only, no card
    expect(kinds(out, 'error')).toHaveLength(1);
    expect(kinds(out, 'error')[0]).toMatchObject({ class: 'policy', retryable: false });
  });
  it.each(['readOnly', 'ask', 'edit'] as const)('%s: the same Ask still shows the card', async (mode) => {
    const { gate, out } = rig(fixed(ASK), { mode });
    void gate.canUseTool('Bash', { command: 'make' }, cuOpts('u3'));
    await tick();
    expect(kinds(out, 'permission.request')[0].options).toEqual(['allow_once', 'deny']);
    expect(kinds(out, 'error')).toHaveLength(0);
  });
  it('keys on the RUN mode: a read-only delegate in an Automatic run was already denied by Rust, and the gate shows that reason, not the internal-error text', async () => {
    const rustDeny: PolicyDecision = { decision: 'deny', by: 'roleDeny', reason: 'this sub-agent is read-only and the run is unattended', rule: 'delegate.read-only' };
    const { gate, out } = rig(fixed(rustDeny), { mode: 'automatic', delegating: true });
    const r = decisionOf(await hook(gate, 'WebFetch', { url: 'https://x.invalid' }, 'u4', { agent_id: 'sub1', agent_type: 'researcher' }));
    expect(r?.permissionDecisionReason).toContain('delegate.read-only');
    expect(r?.permissionDecisionReason).not.toContain('internal error');
    expect(kinds(out, 'error')).toHaveLength(0);
  });
});

describe('mode drift check in the hook (6.3 item 4)', () => {
  it.each(['bypassPermissions', 'dontAsk', 'auto'])('a hook input in CLI mode %s is denied without asking policy, and says so once', async (cliMode) => {
    let calls = 0;
    const { gate, out } = rig({ decide: async () => { calls++; return ALLOW; } }, { mode: 'automatic' });
    const r = decisionOf(await hook(gate, 'Read', { file_path: '/r/a' }, 'd1', { permission_mode: cliMode }));
    expect(r).toMatchObject({ permissionDecision: 'deny' });
    expect(r?.permissionDecisionReason).toContain(`${DENY_MARK}: the CLI is in a permission mode the IDE did not request`);
    await hook(gate, 'Read', { file_path: '/r/b' }, 'd2', { permission_mode: cliMode });
    expect(calls).toBe(0);
    expect(kinds(out, 'error')).toHaveLength(1);
    expect(kinds(out, 'error')[0]).toMatchObject({ class: 'policy', message: expect.stringContaining(cliMode) });
  });
  it.each(['default', 'acceptEdits', 'plan', undefined, 'somethingNew'])('CLI mode %s is not compared (the transient values around a live switch are legal)', async (cliMode) => {
    const { gate } = rig(fixed(ALLOW));
    expect(await hook(gate, 'Read', { file_path: '/r/a' }, 'd3', cliMode === undefined ? {} : { permission_mode: cliMode })).toEqual({ continue: true });
  });
  it('an allow stays { continue: true } in every IDE mode, never an explicit permissionDecision allow', async () => {
    for (const mode of ['readOnly', 'ask', 'edit', 'automatic', 'bypass'] as const) {
      const { gate } = rig(fixed(ALLOW), { mode });
      expect(await hook(gate, 'Write', { file_path: '/r/a' }, `d4-${mode}`)).toEqual({ continue: true });
    }
  });
});

describe('ExitPlanMode approval (6.3 item 6, 4.10)', () => {
  const PLAN_ASK: PolicyDecision = { decision: 'ask', by: 'roleDeny', reason: 'the user approves the plan', rule: 'other.exit-plan' };
  const planReq = (out: WireEvent[]) => kinds(out, 'permission.request')[0];

  it('the card carries the full plan, never allow_run, and the three working modes', async () => {
    const { gate, out } = rig(fixed(PLAN_ASK), { mode: 'readOnly' });
    expect(decisionOf(await hook(gate, 'ExitPlanMode', { plan: '# Plan' }, 'p0'))).toMatchObject({ permissionDecision: 'ask' });
    void gate.canUseTool('ExitPlanMode', { plan: '# Plan\n\nstep one\n\nstep two', planFilePath: '/p/plan.md' }, cuOpts('p0'));
    await tick();
    const req = planReq(out);
    expect(req).toMatchObject({ reqId: 'perm-p0', toolId: 'p0', options: ['allow_once', 'deny'], plan: '# Plan\n\nstep one\n\nstep two', modes: ['ask', 'edit', 'automatic'], intent: { tool: 'ExitPlanMode', summary: 'ExitPlanMode: leave plan mode' } });
    expect(req).not.toHaveProperty('planTruncated');
    expect(req).not.toHaveProperty('sessionAllow');
    expect(JSON.stringify(req.intent)).not.toContain('step one'); // the plan travels in its own field, not in the intent summary
  });

  it.each([['ask', 'default'], ['edit', 'acceptEdits'], ['automatic', 'acceptEdits']] as const)('approve with %s answers the CLI with setMode %s, after the session followed, and reports planApproved', async (mode, sdkMode) => {
    const { gate, out, holder, noted } = rig(fixed(PLAN_ASK), { mode: 'readOnly' });
    const input = { plan: 'the plan' };
    const p = gate.canUseTool('ExitPlanMode', input, cuOpts('p1'));
    await tick();
    gate.answer('perm-p1', { outcome: 'allow', mode });
    const r = await p;
    expect(r).toEqual({ behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: sdkMode, destination: 'session' }] });
    expect(noted).toEqual([mode]);
    expect(holder.mode).toBe(mode);
    const order = out.map((e) => e.kind);
    expect(order.indexOf('permission.resolved')).toBeLessThan(order.indexOf('session.info'));
    expect(kinds(out, 'permission.resolved')[0]).toMatchObject({ outcome: 'allow', by: 'user' });
    expect(kinds(out, 'session.info')[0]).toMatchObject({ effective: { permission: mode, reason: 'planApproved' } });
  });

  it.each(['bypass', 'readOnly', undefined] as const)('an approval naming %s (the host never sends it) falls to Ask, the strictest working mode', async (mode) => {
    const { gate, noted } = rig(fixed(PLAN_ASK), { mode: 'readOnly' });
    const p = gate.canUseTool('ExitPlanMode', { plan: 'x' }, cuOpts('p2'));
    await tick();
    gate.answer('perm-p2', { outcome: 'allow', ...(mode ? { mode } : {}) });
    expect(await p).toMatchObject({ updatedPermissions: [{ type: 'setMode', mode: 'default' }] });
    expect(noted).toEqual(['ask']);
  });

  it('reject returns the feedback verbatim, keeps the mode, and sets no mode', async () => {
    const { gate, out, holder, noted, denied } = rig(fixed(PLAN_ASK), { mode: 'readOnly' });
    const p = gate.canUseTool('ExitPlanMode', { plan: 'x' }, cuOpts('p3'));
    await tick();
    gate.answer('perm-p3', { outcome: 'deny', message: 'Split step two in two parts.' });
    expect(await p).toEqual({ behavior: 'deny', message: 'Split step two in two parts.' });
    expect(holder.mode).toBe('readOnly');
    expect(noted).toEqual([]);
    expect(kinds(out, 'session.info')).toHaveLength(0);
    expect(denied.has('p3')).toBe(true);
  });
  it('reject without a note uses the default revise message; a cancel says cancelled', async () => {
    const a = rig(fixed(PLAN_ASK), { mode: 'readOnly' });
    const pa = a.gate.canUseTool('ExitPlanMode', { plan: 'x' }, cuOpts('p4'));
    await tick();
    a.gate.answer('perm-p4', { outcome: 'deny' });
    expect(await pa).toEqual({ behavior: 'deny', message: PLAN_REJECT_DEFAULT });
    const b = rig(fixed(PLAN_ASK), { mode: 'readOnly' });
    const pb = b.gate.canUseTool('ExitPlanMode', { plan: 'x' }, cuOpts('p5'));
    await tick();
    b.gate.cancelPending('cancelled');
    expect(await pb).toEqual({ behavior: 'deny', message: 'cancelled' });
  });

  it('an empty input.plan (the CLI sent {}) falls back to the last assistant text', async () => {
    const { gate, out } = rig(fixed(PLAN_ASK), { mode: 'readOnly', lastText: 'The plan as a message.' });
    void gate.canUseTool('ExitPlanMode', {}, cuOpts('p6'));
    await tick();
    expect(planReq(out)).toMatchObject({ plan: 'The plan as a message.' });
  });

  it('cuts the plan at 64 KiB, flags planTruncated, and never splits a character', async () => {
    const { gate, out } = rig(fixed(PLAN_ASK), { mode: 'readOnly' });
    void gate.canUseTool('ExitPlanMode', { plan: 'é'.repeat(PLAN_MAX_BYTES) }, cuOpts('p7')); // 2 bytes each
    await tick();
    const req = planReq(out);
    expect(req.planTruncated).toBe(true);
    expect(Buffer.byteLength(req.plan)).toBeLessThanOrEqual(PLAN_MAX_BYTES);
    expect(req.plan).not.toContain('�');
  });

  it('redacts the plan text before it leaves the sidecar (and before the cut)', async () => {
    const { gate, out } = rig(fixed(PLAN_ASK), { mode: 'readOnly' });
    void gate.canUseTool('ExitPlanMode', { plan: 'Use the key sk-ant-api03-abcdefghijklmnop and token=ghp_abcdefghijklmnopqrstuv in the script.' }, cuOpts('p8'));
    await tick();
    expect(planReq(out).plan).not.toContain('sk-ant-api03');
    expect(planReq(out).plan).not.toContain('ghp_abcdefghijklmnopqrstuv');
    expect(planReq(out).plan).toContain('<redacted');
  });

  it('Rust says allow (the run is no longer in Plan): allowed with the input, no card, no mode change', async () => {
    const { gate, out, noted } = rig(fixed({ decision: 'allow', by: 'saved', rule: 'other.ui-card' }), { mode: 'ask' });
    const input = { plan: 'x' };
    expect(await gate.canUseTool('ExitPlanMode', input, cuOpts('p9'))).toEqual({ behavior: 'allow', updatedInput: input });
    expect(kinds(out, 'permission.request')).toHaveLength(0);
    expect(noted).toEqual([]);
  });

  it('a delegate never reaches the card: Rust denies it and the gate relays the denial', async () => {
    const rust: PolicyDecision = { decision: 'deny', by: 'roleDeny', reason: 'only the lead leaves plan mode', rule: 'other.exit-plan-delegate' };
    const { gate, out } = rig(fixed(rust), { mode: 'readOnly', delegating: true });
    const r = await gate.canUseTool('ExitPlanMode', { plan: 'x' }, cuOpts('p10', { agentID: 'sub1' }));
    expect(r).toMatchObject({ behavior: 'deny', message: expect.stringContaining('other.exit-plan-delegate') });
    expect(kinds(out, 'permission.request').every((e) => e.options.length === 1)).toBe(true);
  });
});

describe('decision epoch (6.3 item 8)', () => {
  it('an unchanged epoch reuses the cached decision: one policy call', async () => {
    let calls = 0;
    const { gate } = rig({ decide: async () => { calls++; return ALLOW; } }, { mode: 'automatic' });
    await hook(gate, 'Write', { file_path: '/r/a' }, 'e1');
    await gate.canUseTool('Write', { file_path: '/r/a' }, cuOpts('e1'));
    expect(calls).toBe(1);
  });
  it('a call decided allow under automatic whose canUseTool runs after a switch to readOnly is decided again and denied', async () => {
    let calls = 0;
    const policy: PolicyClient = { decide: async () => { calls++; return calls === 1 ? ALLOW : { decision: 'deny', by: 'roleDeny', reason: 'plan only', rule: 'role.read-only' }; } };
    const { gate, holder } = rig(policy, { mode: 'automatic' });
    expect(await hook(gate, 'Write', { file_path: '/r/a' }, 'e2')).toEqual({ continue: true });
    holder.mode = 'readOnly'; gate.bumpEpoch(); // what ClaudeSession.setPermission does
    expect(await gate.canUseTool('Write', { file_path: '/r/a' }, cuOpts('e2'))).toMatchObject({ behavior: 'deny', message: expect.stringContaining('role.read-only') });
    expect(calls).toBe(2);
  });
  it('the same with a switch to ask: a card appears', async () => {
    let calls = 0;
    const { gate, holder, out } = rig({ decide: async () => (++calls === 1 ? ALLOW : ASK) }, { mode: 'automatic' });
    await hook(gate, 'Bash', { command: 'make' }, 'e3');
    holder.mode = 'ask'; gate.bumpEpoch();
    void gate.canUseTool('Bash', { command: 'make' }, cuOpts('e3'));
    await tick();
    expect(kinds(out, 'permission.request')[0]).toMatchObject({ reqId: 'perm-e3', options: ['allow_once', 'deny'] });
    expect(calls).toBe(2);
  });
  it('a verdict that is still in flight when the epoch moves is stale on arrival', async () => {
    let release!: () => void;
    let calls = 0;
    const { gate } = rig({ decide: async () => { calls++; if (calls === 1) await new Promise<void>((r) => { release = r; }); return ALLOW; } }, { mode: 'automatic' });
    const first = hook(gate, 'Write', { file_path: '/r/a' }, 'e4');
    await tick();
    gate.bumpEpoch();
    release();
    await first;
    await gate.canUseTool('Write', { file_path: '/r/a' }, cuOpts('e4'));
    expect(calls).toBe(2);
  });
  it('documents kind (c): a hook-allowed call the CLI auto-accepts never reaches canUseTool, so nothing re-decides it', async () => {
    let calls = 0;
    const { gate, holder } = rig({ decide: async () => { calls++; return ALLOW; } }, { mode: 'automatic' });
    await hook(gate, 'Write', { file_path: '/r/a' }, 'e5');
    holder.mode = 'readOnly'; gate.bumpEpoch(); // switched; the fake CLI never calls canUseTool for an in-cwd Write under acceptEdits
    expect(calls).toBe(1); // the epoch is not a complete guard: only calls that ask or are CLI-prompted are re-decided
  });
});

describe('CLI-originated prompts in an unattended run (6.3 item 9)', () => {
  const BOUNDARY = 'Path is outside allowed working directories';
  it('CLI_BENIGN_REASONS is exactly the measured reasons (extend only with a reason a live probe measured: L2 boundary, L5 no-rule)', () => {
    expect([...CLI_BENIGN_REASONS]).toEqual([BOUNDARY, 'This command requires approval']);
  });
  it.each(['automatic', 'bypass'] as const)('%s: the CLI guard for `cd <dir> && git ...` (live probe L9) is answered from the cached Rust allow; a look-alike reason is answered in Bypass only', async (mode) => {
    const { gate, out } = rig(fixed(ALLOW), { mode, cwd: '/work', runDirs: ['/work', '/other'] });
    const reason = 'This command changes directory before running a version-control command, which can pick up untrusted hooks or repos. Requires approval';
    expect(await gate.canUseTool('Bash', { command: 'cd /other && git status --short' }, cuOpts('cd1', { decisionReason: reason }))).toMatchObject({ behavior: 'allow' });
    expect(kinds(out, 'error')).toHaveLength(0);
    expect(await gate.canUseTool('Bash', { command: 'git status' }, cuOpts('cd2', { decisionReason: 'Contains command_substitution' }))).toMatchObject({ behavior: mode === 'automatic' ? 'deny' : 'allow' });
  });
  it.each(['automatic', 'bypass'] as const)('%s: the generic "no rule matched" prompt of a script-style command is answered from the cached Rust allow', async (mode) => {
    const { gate, out } = rig(fixed(ALLOW), { mode });
    expect(await gate.canUseTool('Bash', { command: 'npm test' }, cuOpts('c0', { decisionReason: 'This command requires approval' }))).toMatchObject({ behavior: 'allow' });
    expect(kinds(out, 'error')).toHaveLength(0);
  });
  it('bypass has no boundary (D6): the boundary prompt of a Write or a Bash command outside the cwd is answered from the cached Rust allow', async () => {
    const { gate, out } = rig(fixed(ALLOW), { mode: 'bypass', cwd: '/work' });
    expect(await gate.canUseTool('Write', { file_path: '/outside/x' }, cuOpts('c1', { decisionReason: BOUNDARY }))).toMatchObject({ behavior: 'allow' }); // measured: Write outside carries the reason and no blockedPath
    expect(await gate.canUseTool('Bash', { command: 'rm -rf /outside/x' }, cuOpts('c1b', { blockedPath: '/outside/x' }))).toMatchObject({ behavior: 'allow' }); // measured: Bash outside carries blockedPath and no reason
    expect(await gate.canUseTool('Bash', { command: 'make' }, cuOpts('c2', { decisionReason: '' }))).toMatchObject({ behavior: 'allow' });
    expect(await gate.canUseTool('Bash', { command: 'echo x | tee f' }, cuOpts('c3'))).toMatchObject({ behavior: 'allow' });
    expect(kinds(out, 'error')).toHaveLength(0);
  });
  it('automatic: a no-reason prompt (tee, export) and a path inside the run directories are answered from the cache', async () => {
    const { gate, out } = rig(fixed(ALLOW), { mode: 'automatic', cwd: '/work', runDirs: ['/work', '/attach'] });
    expect(await gate.canUseTool('Bash', { command: 'echo x | tee f' }, cuOpts('c2a'))).toMatchObject({ behavior: 'allow' });
    expect(await gate.canUseTool('Bash', { command: 'cat /attach/a.txt' }, cuOpts('c2b', { blockedPath: '/attach/a.txt' }))).toMatchObject({ behavior: 'allow' }); // an added directory counts
    expect(await gate.canUseTool('Write', { file_path: '/work/sub/a' }, cuOpts('c2c', { decisionReason: BOUNDARY }))).toMatchObject({ behavior: 'allow' }); // the CLI and Rust disagree about a path that is inside: Rust wins
    expect(kinds(out, 'error')).toHaveLength(0);
  });
  it('automatic stays inside the run folders (D5): a boundary prompt for a path outside them is denied although Rust allowed the call, with an actionable message', async () => {
    const { gate, out } = rig(fixed(ALLOW), { mode: 'automatic', cwd: '/work', runDirs: ['/work'] });
    const w = await gate.canUseTool('Write', { file_path: '/outside/x' }, cuOpts('c2d', { decisionReason: BOUNDARY }));
    expect(w).toMatchObject({ behavior: 'deny', message: expect.stringContaining('use Bypass for paths outside them') });
    const b = await gate.canUseTool('Bash', { command: 'ls /etc' }, cuOpts('c2e', { blockedPath: '/private/etc' }));
    expect(b).toMatchObject({ behavior: 'deny', message: expect.stringContaining('path outside the run') });
    expect(kinds(out, 'error').map((e) => e.class)).toEqual(['policy', 'policy']);
    expect(await gate.canUseTool('Write', { file_path: '/outside/x' }, cuOpts('c2f', { decisionReason: BOUNDARY }))).toMatchObject({ behavior: 'deny' }); // same reason again: still denied, no third error
    expect(kinds(out, 'error')).toHaveLength(2);
  });
  it('the measured not-benign reasons (sensitive file, command substitution, find -delete, .. traversal) are denied in Automatic; Bypass has no prompts (D6) and refuses only the sensitive-file one', async () => {
    const REASONS = [
      'Claude requested permissions to edit /work/.bashrc which is a sensitive file.', 'Contains command_substitution',
      "find with '-delete' executes commands or modifies files \u2014 cannot be auto-allowed by a Bash(find:*) prefix rule",
      "Path contains '..' traversal after a directory segment, which may follow a symlink outside the working directory",
    ];
    for (const mode of ['automatic', 'bypass'] as const) {
      const { gate } = rig(fixed(ALLOW), { mode, cwd: '/work', runDirs: ['/work'] });
      let n = 0;
      for (const reason of REASONS) {
        const want = mode === 'automatic' || /sensitive file/.test(reason) ? 'deny' : 'allow';
        expect(await gate.canUseTool('Bash', { command: 'x' }, cuOpts(`nb${mode}${n++}`, { decisionReason: reason })), `${mode}: ${reason}`).toMatchObject({ behavior: want });
      }
    }
  });
  it('the boundary reason with a cached Rust Deny stays denied', async () => {
    const { gate } = rig(fixed({ decision: 'deny', by: 'hardStop', reason: 'outside the jail', rule: 'fs.outside-jail' }), { mode: 'automatic' });
    expect(await gate.canUseTool('Write', { file_path: '/outside/x' }, cuOpts('c4', { decisionReason: BOUNDARY, blockedPath: '/outside/x' }))).toMatchObject({ behavior: 'deny' });
  });
  it('bypass: an unmeasured reason is answered from the cached Rust allow (no prompts, D6), a sensitive file is not', async () => {
    const { gate, out } = rig(fixed(ALLOW), { mode: 'bypass' });
    expect(await gate.canUseTool('Bash', { command: 'echo $(id)' }, cuOpts('b5', { decisionReason: 'Contains command substitution' }))).toMatchObject({ behavior: 'allow' });
    expect(await gate.canUseTool('Bash', { command: 'rm -rf ~' }, cuOpts('b7', { decisionReason: 'Dangerous command' }))).toMatchObject({ behavior: 'allow' });
    expect(kinds(out, 'error')).toHaveLength(0);
    expect(await gate.canUseTool('Edit', { file_path: '/work/.mcp.json' }, cuOpts('b8', { decisionReason: 'Claude requested permissions to edit /work/.mcp.json which is a sensitive file.' }))).toMatchObject({ behavior: 'deny' });
  });
  it.each(['automatic'] as const)('%s: an unmeasured reason is denied with a message that names it, once per session and reason', async (mode) => {
    const { gate, out, denied } = rig(fixed(ALLOW), { mode });
    const r1 = await gate.canUseTool('Bash', { command: 'echo $(id)' }, cuOpts('c5', { decisionReason: 'Contains command substitution' }));
    expect(r1).toMatchObject({ behavior: 'deny' });
    const msg = (r1 as { message: string }).message;
    expect(msg).toContain('Contains command substitution');
    expect(msg).toContain(mode === 'automatic' ? 'Automatic' : 'Bypass');
    expect(msg).toContain('switch to Ask');
    expect(denied.has('c5')).toBe(true);
    await gate.canUseTool('Bash', { command: 'echo $(whoami)' }, cuOpts('c6', { decisionReason: 'Contains command substitution' })); // same reason: no second error
    await gate.canUseTool('Bash', { command: 'rm -rf ~' }, cuOpts('c7', { decisionReason: 'Dangerous command' }));
    const errs = kinds(out, 'error');
    expect(errs.map((e) => e.class)).toEqual(['policy', 'policy']);
    expect(errs[0].message).toContain('Contains command substitution');
    expect(errs[1].message).toContain('Dangerous command');
    expect(kinds(out, 'permission.resolved').filter((e) => e.outcome === 'deny')).toHaveLength(3); // each refusal is visible to the Inspector
  });
  it('a blockedPath that Rust did not judge (a file tool whose paths differ) is denied; a covered one is allowed', async () => {
    const { gate } = rig(fixed(ALLOW), { mode: 'automatic', cwd: '/work' });
    expect(await gate.canUseTool('Write', { file_path: '/work/a.txt' }, cuOpts('c8', { decisionReason: BOUNDARY, blockedPath: '/elsewhere/secret' }))).toMatchObject({ behavior: 'deny', message: expect.stringContaining(BOUNDARY) });
    expect(await gate.canUseTool('Write', { file_path: '/work/a.txt' }, cuOpts('c8b', { blockedPath: '/elsewhere/secret' }))).toMatchObject({ behavior: 'deny', message: expect.stringContaining('blocked path /elsewhere/secret') });
    expect(await gate.canUseTool('Write', { file_path: 'a.txt' }, cuOpts('c9', { decisionReason: BOUNDARY, blockedPath: '/work/a.txt' }))).toMatchObject({ behavior: 'allow' }); // relative path resolved against the cwd
    expect(await gate.canUseTool('Edit', { file_path: '/work/dir/b.txt' }, cuOpts('c10', { blockedPath: '/work/dir/b.txt' }))).toMatchObject({ behavior: 'allow' });
  });
  it.each(['readOnly', 'ask', 'edit'] as const)('%s: nothing changes, an unknown reason with a cached allow is answered as before', async (mode) => {
    const { gate, out } = rig(fixed(ALLOW), { mode });
    expect(await gate.canUseTool('Bash', { command: 'echo $(id)' }, cuOpts('c11', { decisionReason: 'Contains command substitution' }))).toMatchObject({ behavior: 'allow' });
    expect(kinds(out, 'error')).toHaveLength(0);
  });
  it.each(['automatic', 'bypass'] as const)('%s: a heredoc file write that only its content makes look suspicious is answered from the cached Rust allow', async (mode) => {
    const { gate, out } = rig(fixed(ALLOW), { mode, cwd: '/work', runDirs: ['/work'] });
    const write = "mkdir -p /tmp/u && cat > src/a.js <<'EOF'\nconst a = {\"x\": 1}; // <1-3> $(date)\nEOF";
    for (const [n, reason] of ['Contains brace with quote character (expansion obfuscation)', 'Contains zsh <N-M> numeric-range glob', 'Contains command_substitution'].entries()) {
      expect(await gate.canUseTool('Bash', { command: write }, cuOpts(`hd${mode}${n}`, { decisionReason: reason })), `${mode}: ${reason}`).toMatchObject({ behavior: 'allow' });
    }
    expect(kinds(out, 'error')).toHaveLength(0);
  });
  it('automatic: the same reasons on a command whose syntax is suspicious are refused, with the hint and as a policy block (not an outage)', async () => {
    const { gate, out } = rig(fixed(ALLOW), { mode: 'automatic', cwd: '/work', runDirs: ['/work'] });
    const r = await gate.canUseTool('Bash', { command: 'echo {"a","b"} > f' }, cuOpts('hd9', { decisionReason: 'Contains brace with quote character (expansion obfuscation)' }));
    expect(r).toMatchObject({ behavior: 'deny', message: expect.stringContaining('Write or Edit tool') });
    expect(await gate.canUseTool('Bash', { command: "bash <<'EOF'\n{\"a\"}\nEOF" }, cuOpts('hd10', { decisionReason: 'Contains brace with quote character (expansion obfuscation)' }))).toMatchObject({ behavior: 'deny' });
    expect(kinds(out, 'permission.resolved').filter((e) => e.outcome === 'deny').map((e) => e.by)).toEqual(['hardStop', 'hardStop']);
  });
  it.each(['ask', 'edit'] as const)('%s: a CLI prompt that Rust asks about still shows the card', async (mode) => {
    const { gate, out } = rig(fixed(ASK), { mode });
    void gate.canUseTool('Bash', { command: 'make' }, cuOpts('c12', { decisionReason: BOUNDARY, blockedPath: '/outside' }));
    await tick();
    expect(kinds(out, 'permission.request')[0]).toMatchObject({ options: ['allow_once', 'deny'] });
  });
});
