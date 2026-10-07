// Notes to a running agent: the queue, delivery with the target's next allowed tool call (Claude gate), the mock adapter, and session/note in the host.
import { describe, expect, it } from 'vitest';
import { MAX_NOTE_CHARS, NoteError } from '../src/abstract.js';
import { ToolGate } from '../src/adapters/claude-sdk/gate.js';
import provider from '../src/adapters/mock/index.js';
import { SidecarHost } from '../src/host.js';
import { Loader } from '../src/loader.js';
import { LEAD, noteContext, NoteQueue } from '../src/note-queue.js';
import { ProtocolClient } from '../src/protocol.js';
import { checkInvariants, SeqSink, TurnGuard } from '../src/turn.js';
import type { AgentProvider, AgentSession, EventSink, PolicyClient, PolicyDecision, SessionSpec, WireEvent } from '../src/types.js';

const notesOf = (out: WireEvent[]) => out.filter((e) => e.kind === 'note') as Extract<WireEvent, { kind: 'note' }>[];
const states = (out: WireEvent[], noteId: string) => notesOf(out).filter((e) => e.noteId === noteId).map((e) => e.state);

describe('the note queue', () => {
  const rig = () => {
    const out: WireEvent[] = [];
    const guard = new TurnGuard(new SeqSink((e) => out.push(e)));
    guard.beginTurn();
    return { out, q: new NoteQueue(guard) };
  };

  it('reports a note as queued with its trimmed, redacted text and its target', () => {
    const { q, out } = rig();
    q.add({ noteId: 'n1', text: '  use the staging db  ' });
    q.add({ noteId: 'n2', text: 'token=abcdef123456 is the key', parentToolId: 'ag1' });
    expect(out[0]).toMatchObject({ kind: 'note', noteId: 'n1', state: 'queued', text: 'use the staging db' });
    expect(out[0]).not.toHaveProperty('parentToolId');
    expect(out[1]).toMatchObject({ noteId: 'n2', state: 'queued', parentToolId: 'ag1' });
    expect((out[1] as { text: string }).text).not.toContain('abcdef123456');
    expect(out[0]).toMatchObject({ turnId: 'turn-1' });
  });

  it('hands a target its notes oldest first in one block and leaves the other targets alone', () => {
    const { q, out } = rig();
    q.add({ noteId: 'a', text: 'first' });
    q.add({ noteId: 'b', text: 'for the sub-agent', parentToolId: 'ag1' });
    q.add({ noteId: 'c', text: 'second' });
    expect(q.take(LEAD, 'tool-9')).toBe(noteContext(['first', 'second']));
    expect(q.take(LEAD, 'tool-10')).toBeUndefined();
    expect(q.has('ag1')).toBe(true);
    expect(notesOf(out).filter((e) => e.state === 'delivered').map((e) => [e.noteId, e.toolId, e.parentToolId])).toEqual([['a', 'tool-9', undefined], ['c', 'tool-9', undefined]]);
    expect(q.take('ag1', 'tool-11')).toBe(noteContext(['for the sub-agent']));
  });

  it('words one note and several notes differently', () => {
    expect(noteContext(['one'])).toMatch(/^Note from the user, added while you work/);
    expect(noteContext(['one'])).toMatch(/\none$/);
    expect(noteContext(['one', 'two'])).toMatch(/^Notes from the user, added while you work/);
    expect(noteContext(['one', 'two'])).toMatch(/\n1\. one\n2\. two$/);
  });

  it('drops what nobody can read any more, with the reason', () => {
    const { q, out } = rig();
    q.add({ noteId: 'a', text: 'x', parentToolId: 'ag1' });
    q.add({ noteId: 'b', text: 'y' });
    q.dropTarget('ag1', 'finished');
    q.dropAll('turnEnded');
    q.dropAll('turnEnded'); // nothing left: silent
    expect(notesOf(out).filter((e) => e.state === 'dropped').map((e) => [e.noteId, e.reason, e.parentToolId])).toEqual([['a', 'finished', 'ag1'], ['b', 'turnEnded', undefined]]);
    expect(q.size).toBe(0);
  });

  it('refuses an empty note, a long one, a repeated id and a runaway', () => {
    const { q } = rig();
    expect(() => q.add({ noteId: 'e', text: '   ' })).toThrow(expect.objectContaining({ code: 'empty' }));
    expect(() => q.add({ noteId: 'l', text: 'x'.repeat(MAX_NOTE_CHARS + 1) })).toThrow(expect.objectContaining({ code: 'tooLong' }));
    q.add({ noteId: 'ok', text: 'x'.repeat(MAX_NOTE_CHARS) });
    expect(() => q.add({ noteId: 'ok', text: 'again' })).toThrow(expect.objectContaining({ code: 'failed' }));
    for (let i = 0; i < 19; i++) q.add({ noteId: `n${i}`, text: 'x' });
    expect(() => q.add({ noteId: 'one-too-many', text: 'x' })).toThrow(NoteError);
  });
});

describe('delivery through the Claude tool gate', () => {
  const allow: PolicyClient = { decide: async () => ({ decision: 'allow', by: 'saved' }) };
  const rig = (policy: PolicyClient = allow) => {
    const out: WireEvent[] = [];
    const guard = new TurnGuard(new SeqSink((e) => out.push(e)));
    guard.beginTurn();
    const gate = new ToolGate({ agentId: 'a1', provider: 'claude', policy, sink: guard, denied: new Set(), mode: () => 'ask' });
    return { out, gate };
  };
  const hook = (g: ToolGate, tool: string, id: string, extra: Record<string, unknown> = {}, input: unknown = { command: 'ls' }) =>
    g.preToolUse({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: id, ...extra } as never, id, { signal: new AbortController().signal });
  const ctx = (r: unknown) => (r as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext;

  it('the lead gets its note with its next allowed tool call, once', async () => {
    const { gate, out } = rig();
    gate.noteToolParent('t1', null);
    gate.noteToolParent('t2', null);
    gate.addNote({ noteId: 'n1', text: 'prefer small commits' });
    const r = await hook(gate, 'Bash', 't1');
    expect(r).toMatchObject({ continue: true, hookSpecificOutput: { hookEventName: 'PreToolUse' } });
    expect(ctx(r)).toBe(noteContext(['prefer small commits']));
    expect(ctx(await hook(gate, 'Bash', 't2'))).toBeUndefined();
    expect(await hook(gate, 'Bash', 't2')).toEqual({ continue: true });
    expect(notesOf(out).map((e) => [e.state, e.toolId])).toEqual([['queued', undefined], ['delivered', 't1']]);
  });

  it('a refused call and a call that needs a card keep the note for the next one', async () => {
    let verdict: PolicyDecision = { decision: 'deny', by: 'hardStop', reason: 'no' };
    const { gate, out } = rig({ decide: async () => verdict });
    for (const id of ['d1', 'k1', 'a1']) gate.noteToolParent(id, null);
    gate.addNote({ noteId: 'n1', text: 'keep me' });
    expect(ctx(await hook(gate, 'Bash', 'd1'))).toBeUndefined();
    verdict = { decision: 'ask', by: 'roleDeny' };
    expect(ctx(await hook(gate, 'Write', 'k1', {}, { file_path: '/r/a' }))).toBeUndefined();
    expect(states(out, 'n1')).toEqual(['queued']);
    verdict = { decision: 'allow', by: 'saved' };
    expect(ctx(await hook(gate, 'Bash', 'a1'))).toContain('keep me');
    expect(states(out, 'n1')).toEqual(['queued', 'delivered']);
  });

  it('a note rides on an Agent call next to the rewritten input', async () => {
    const { gate } = rig();
    gate.noteToolParent('ag1', null);
    gate.addNote({ noteId: 'n1', text: 'be brief' });
    const r = (await hook(gate, 'Agent', 'ag1', {}, { subagent_type: 'x', prompt: 'p' })) as { hookSpecificOutput: Record<string, unknown> };
    expect(r.hookSpecificOutput).toMatchObject({ permissionDecision: 'allow', updatedInput: { run_in_background: false }, additionalContext: expect.stringContaining('be brief') });
  });

  it('a sub-agent gets only its own notes, the lead only the lead\'s', async () => {
    const { gate, out } = rig();
    gate.noteToolParent('ag1', null);
    await hook(gate, 'Agent', 'ag1', {}, { subagent_type: 'x', prompt: 'p' });
    gate.addNote({ noteId: 'sub', text: 'for the researcher', parentToolId: 'ag1' });
    gate.addNote({ noteId: 'lead', text: 'for the lead' });
    gate.noteToolParent('s1', 'ag1');
    gate.noteToolParent('l1', null);
    expect(ctx(await hook(gate, 'Read', 's1', { agent_id: 'sub-1', agent_type: 'researcher' }, { file_path: '/r/a' }))).toBe(noteContext(['for the researcher']));
    expect(states(out, 'lead')).toEqual(['queued']);
    expect(ctx(await hook(gate, 'Bash', 'l1'))).toBe(noteContext(['for the lead']));
  });

  it('learns which sub-agent an agent_id is, so a call the stream has not announced yet is still told apart', async () => {
    const { gate } = rig();
    gate.noteToolParent('ag1', null);
    await hook(gate, 'Agent', 'ag1', {}, { subagent_type: 'x', prompt: 'p' });
    gate.addNote({ noteId: 'sub', text: 'later' , parentToolId: 'ag1' });
    // the hook is faster than the stream: the call's message has not been read, the agent is not known either -> nothing rides on it
    expect(ctx(await hook(gate, 'Read', 'early', { agent_id: 'sub-1' }, { file_path: '/r/a' }))).toBeUndefined();
    // a later call of the same agent is announced: this teaches the gate that sub-1 belongs to ag1
    gate.noteToolParent('known', 'ag1');
    expect(ctx(await hook(gate, 'Read', 'known', { agent_id: 'sub-1' }, { file_path: '/r/a' }))).toContain('later');
    gate.addNote({ noteId: 'sub2', text: 'and again', parentToolId: 'ag1' });
    expect(ctx(await hook(gate, 'Read', 'unannounced', { agent_id: 'sub-1' }, { file_path: '/r/a' }))).toContain('and again');
  });

  it('a call without agent_id is not the lead while a sub-agent runs and its origin is unknown', async () => {
    const { gate } = rig();
    gate.noteToolParent('ag1', null);
    await hook(gate, 'Agent', 'ag1', {}, { subagent_type: 'x', prompt: 'p' });
    gate.addNote({ noteId: 'lead', text: 'for the lead' });
    expect(ctx(await hook(gate, 'Bash', 'who'))).toBeUndefined();
  });

  it('refuses a note for a sub-agent that is not running and drops the notes of one that ends', async () => {
    const { gate, out } = rig();
    expect(() => gate.addNote({ noteId: 'x', text: 'hi', parentToolId: 'ag1' })).toThrow(expect.objectContaining({ code: 'unknownTarget' }));
    gate.noteToolParent('ag1', null);
    await hook(gate, 'Agent', 'ag1', {}, { subagent_type: 'x', prompt: 'p' });
    gate.addNote({ noteId: 'n1', text: 'hi', parentToolId: 'ag1' });
    gate.toolResult('ag1');
    expect(states(out, 'n1')).toEqual(['queued', 'dropped']);
    expect(notesOf(out).at(-1)).toMatchObject({ reason: 'finished', parentToolId: 'ag1' });
    expect(() => gate.addNote({ noteId: 'n2', text: 'late', parentToolId: 'ag1' })).toThrow(NoteError);
  });

  it('drops what is left when the turn ends or the user stops', async () => {
    const { gate, out } = rig();
    gate.addNote({ noteId: 'n1', text: 'a' });
    gate.addNote({ noteId: 'n2', text: 'b' });
    gate.dropNotes('cancelled');
    gate.addNote({ noteId: 'n3', text: 'c' });
    gate.turnEnded();
    expect(notesOf(out).filter((e) => e.state === 'dropped').map((e) => [e.noteId, e.reason])).toEqual([['n1', 'cancelled'], ['n2', 'cancelled'], ['n3', 'turnEnded']]);
    expect(checkInvariants(out)).toEqual([]); // a note is outside the turn bookkeeping: reporting one never opens a turn
  });
});

describe('the mock adapter', () => {
  const SCRIPT = [
    '{"op":"start","id":"t1","name":"Agent","toolKind":"other","input":{}}',
    '{"op":"tool","dt":40,"id":"t2","parent":"t1","name":"Read","toolKind":"read","input":{},"ms":150}',
    '{"op":"tool","dt":10,"id":"t3","parent":"t1","name":"Read","toolKind":"read","input":{},"ms":150}',
    '{"op":"emit","event":{"kind":"tool.result","toolId":"t1","status":"ok"}}',
    '{"op":"end"}',
  ].join('\n');
  const open = async () => {
    const out: WireEvent[] = [];
    const guard = new TurnGuard(new SeqSink((e) => out.push(e)));
    const spec: SessionSpec = { agentId: 'a', provider: 'mock', role: { name: 'm', model: 'mock-1', permission: 'edit' }, cwd: '/', addDirs: [], env: {}, mcp: {}, auth: { mode: 'subscription', key: null }, mock: { script: SCRIPT, speed: 1 } };
    const s = await provider.open(spec, guard, allowAll, { registerPid: () => undefined });
    return { s, out, guard };
  };
  const allowAll: PolicyClient = { decide: async () => ({ decision: 'allow', by: 'saved' }) };
  const until = async (pred: () => boolean, ms = 3000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 3)); } };

  it('takes a note only while a turn runs, for the lead or a running sub-agent', async () => {
    const { s, out, guard } = await open();
    expect(() => s.note!({ noteId: 'x', text: 'idle' })).toThrow(expect.objectContaining({ code: 'noTurn' }));
    guard.beginTurn();
    s.prompt({ text: 'go' });
    await until(() => out.some((e) => e.kind === 'tool.start' && (e as { toolId: string }).toolId === 't2'));
    expect(() => s.note!({ noteId: 'x', text: 'hi', parentToolId: 'nope' })).toThrow(expect.objectContaining({ code: 'unknownTarget' }));
    s.note!({ noteId: 'n1', text: 'check the edge cases', parentToolId: 't1' });
    await until(() => out.some((e) => e.kind === 'turn.end'));
    // queued while t2 ran, delivered with the sub-agent's next call t3
    expect(notesOf(out).map((e) => [e.state, e.toolId])).toEqual([['queued', undefined], ['delivered', 't3']]);
    expect(checkInvariants(out)).toEqual([]);
  });

  it('drops a note its sub-agent can no longer read, before the turn ends', async () => {
    const { s, out, guard } = await open();
    guard.beginTurn();
    s.prompt({ text: 'go' });
    await until(() => out.some((e) => e.kind === 'tool.start' && (e as { toolId: string }).toolId === 't3'));
    s.note!({ noteId: 'n1', text: 'too late', parentToolId: 't1' }); // t3 is the last call
    s.note!({ noteId: 'n2', text: 'and for the lead' });
    await until(() => out.some((e) => e.kind === 'turn.end'));
    expect(notesOf(out).filter((e) => e.state === 'dropped').map((e) => [e.noteId, e.reason])).toEqual([['n1', 'finished'], ['n2', 'turnEnded']]);
    const kinds = out.map((e) => e.kind);
    expect(kinds.lastIndexOf('note')).toBeLessThan(kinds.indexOf('turn.end'));
    expect(checkInvariants(out)).toEqual([]);
  });

  it('Stop drops the waiting notes as cancelled', async () => {
    const { s, out, guard } = await open();
    guard.beginTurn();
    s.prompt({ text: 'go' });
    await until(() => out.some((e) => e.kind === 'tool.start' && (e as { toolId: string }).toolId === 't2'));
    s.note!({ noteId: 'n1', text: 'x' });
    await s.interrupt();
    guard.endTurn('cancelled');
    expect(notesOf(out).at(-1)).toMatchObject({ noteId: 'n1', state: 'dropped', reason: 'cancelled' });
    expect(checkInvariants(out)).toEqual([]);
  });
});

describe('session/note in the host', () => {
  function rig(session: Partial<AgentSession> & { onNote?: (sink: EventSink) => void }) {
    const sent: any[] = [];
    const proto = new ProtocolClient({ write: (l) => sent.push(JSON.parse(l)), batchMs: 1 });
    let sink!: EventSink;
    const prov: AgentProvider = {
      id: 'stub', kind: 'cli', detect: async () => ({ installed: true, auth: 'ok' }), capabilities: () => ({}) as never, listModels: async () => [],
      open: async (_spec: SessionSpec, s: EventSink) => { sink = s; return { nativeId: 'n', prompt: () => undefined, interrupt: async () => {}, answer: () => {}, close: async () => {}, ...session } as AgentSession; },
    };
    const host = new SidecarHost(proto, new Loader({ stub: async () => ({ default: prov }) }, ['stub']));
    const orig = proto.request.bind(proto);
    (proto as any).request = (type: string, body: unknown) => (type === 'slot/acquire' ? Promise.resolve({ leaseId: 'L9', ttlMs: 15000 }) : orig(type as never, body as never));
    // a handler's reply is written after a promise tick: `send` waits for it
    const send = async (id: number, type: string, body: unknown) => { proto.receive(JSON.stringify({ v: 1, id, type, body })); await new Promise((r) => setTimeout(r, 5)); };
    const reply = (id: number) => sent.find((m) => m.id === id && m.type === 'reply')?.body;
    const start = { agentId: 'a1', provider: 'stub', role: { name: 'r', model: 'm', permission: 'ask' }, cwd: '/', env: {}, auth: { mode: 'subscription', key: null } };
    return { send, reply, start, sink: () => sink };
  }
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('answers noSession, unsupported, noTurn, empty and tooLong without bothering the adapter', async () => {
    const calls: unknown[] = [];
    const r = rig({ note: (n) => { calls.push(n); } });
    await r.send(1, 'session/note', { agentId: 'a1', noteId: 'n', text: 'x' });
    expect(r.reply(1)).toMatchObject({ error: 'noSession' });
    await r.send(2, 'session/start', r.start);
    await wait(10);
    await r.send(3, 'session/note', { agentId: 'a1', noteId: 'n', text: 'x' });
    expect(r.reply(3)).toMatchObject({ error: 'noTurn' }); // no turn is open
    await r.send(4, 'session/prompt', { agentId: 'a1', text: 'go' });
    await r.send(5, 'session/note', { agentId: 'a1', noteId: 'n', text: '   ' });
    await r.send(6, 'session/note', { agentId: 'a1', noteId: 'n', text: 'x'.repeat(MAX_NOTE_CHARS + 1) });
    expect(r.reply(5)).toMatchObject({ error: 'empty' });
    expect(r.reply(6)).toMatchObject({ error: 'tooLong' });
    expect(calls).toEqual([]);
    await r.send(7, 'session/note', { agentId: 'a1', noteId: 'n7', text: '  hello  ', parentToolId: 'ag1' });
    expect(r.reply(7)).toEqual({ ok: true });
    expect(calls).toEqual([{ noteId: 'n7', text: 'hello', parentToolId: 'ag1' }]);
  });

  it('a provider without notes answers unsupported; an adapter refusal keeps its code', async () => {
    const plain = rig({});
    await plain.send(1, 'session/start', plain.start);
    await wait(10);
    await plain.send(2, 'session/prompt', { agentId: 'a1', text: 'go' });
    await plain.send(3, 'session/note', { agentId: 'a1', noteId: 'n', text: 'x' });
    expect(plain.reply(3)).toMatchObject({ error: 'unsupported' });

    const picky = rig({ note: () => { throw new NoteError('unknownTarget', 'that sub-agent is not running'); } });
    await picky.send(1, 'session/start', picky.start);
    await wait(10);
    await picky.send(2, 'session/prompt', { agentId: 'a1', text: 'go' });
    await picky.send(3, 'session/note', { agentId: 'a1', noteId: 'n', text: 'x', parentToolId: 'gone' });
    expect(picky.reply(3)).toEqual({ error: 'unknownTarget', detail: 'that sub-agent is not running' });

    const broken = rig({ note: () => { throw new Error('boom token=abcdef123456'); } });
    await broken.send(1, 'session/start', broken.start);
    await wait(10);
    await broken.send(2, 'session/prompt', { agentId: 'a1', text: 'go' });
    await broken.send(3, 'session/note', { agentId: 'a1', noteId: 'n', text: 'x' });
    expect(broken.reply(3)).toMatchObject({ error: 'failed' });
    expect(JSON.stringify(broken.reply(3))).not.toContain('abcdef123456');
  });
});
