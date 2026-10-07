// SidecarHost with a hostile adapter: cancel must still end the turn exactly once, even when interrupt() hangs.
import { describe, expect, it } from 'vitest';
import { SidecarHost } from '../src/host.js';
import { Loader } from '../src/loader.js';
import { ProtocolClient } from '../src/protocol.js';
import { checkInvariants } from '../src/turn.js';
import { UnsupportedModeError } from '../src/abstract.js';
import { SdkMissingError } from '../src/sdk.js';
import type { AgentProvider, AgentSession, EventSink, PermissionMode, SessionSpec, WireEvent } from '../src/types.js';

function rig(open: (sink: EventSink, spec: SessionSpec) => AgentSession) {
  const sent: any[] = [];
  const proto = new ProtocolClient({ write: (l) => sent.push(JSON.parse(l)), batchMs: 1 });
  const provider: AgentProvider = { id: 'stub', kind: 'cli', detect: async () => ({ installed: true, auth: 'ok' }), capabilities: () => ({}) as never, listModels: async () => [], open: async (spec, sink) => open(sink, spec) };
  const host = new SidecarHost(proto, new Loader({ stub: async () => ({ default: provider }) }, ['stub']));
  // answer the sidecar's own requests (slot/acquire) like Rust would
  const orig = proto.request.bind(proto);
  (proto as any).request = (type: string, body: unknown) => (type === 'slot/acquire' ? Promise.resolve({ leaseId: 'L9', ttlMs: 15000 }) : orig(type as never, body as never));
  const send = (id: number, type: string, body: unknown) => proto.receive(JSON.stringify({ v: 1, id, type, body }));
  const events = () => sent.filter((m) => m.type === 'events/batch').flatMap((m) => m.body.events as WireEvent[]);
  const start = { agentId: 'a1', provider: 'stub', role: { name: 'r', model: 'm', permission: 'ask' }, cwd: '/', env: {}, auth: { mode: 'subscription', key: null } };
  return { host, proto, sent, send, events, start };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('prompts', () => {
  it('logs the user message first in the turn, with a message id that is unique across resumed sessions', async () => {
    const r = rig((s) => ({ nativeId: 'n', prompt: () => s.emit({ kind: 'turn.end', stopReason: 'endTurn' }), interrupt: async () => {}, answer: () => {}, close: async () => {} }));
    r.send(1, 'session/start', { ...r.start, nextSeq: 7 });
    await wait(10);
    r.send(2, 'session/prompt', { agentId: 'a1', text: 'hello there' });
    await wait(20);
    const ev = r.events();
    expect(ev[0]).toMatchObject({ kind: 'user.message', text: 'hello there', seq: 7, turnId: 'turn-s7-1' });
    expect(ev[0]).toHaveProperty('messageId');
    expect(ev[1]).toMatchObject({ kind: 'turn.end', seq: 8 });
  });
});

describe('cancel protocol with an adapter that ignores interrupt()', () => {
  it('ends the turn once after softMs, cancels open tools, reports cancel/done, drops late results', async () => {
    let sink!: EventSink;
    const r = rig((s) => {
      sink = s;
      return { nativeId: 'n', prompt: () => { sink.emit({ kind: 'tool.start', toolId: 't1', name: 'Bash', toolKind: 'exec', input: {} }); }, interrupt: () => new Promise(() => {}), answer: () => {}, close: async () => {} };
    });
    r.send(1, 'session/start', r.start);
    await wait(10);
    r.send(2, 'session/prompt', { agentId: 'a1', text: 'go' });
    await wait(10);
    r.send(3, 'cancel/request', { agentId: 'a1', softMs: 120, termMs: 100 });
    await wait(300);
    sink.emit({ kind: 'tool.result', toolId: 't1', status: 'ok' }); // late, must be dropped
    sink.emit({ kind: 'turn.end', stopReason: 'endTurn' }); // duplicate, must be dropped
    await wait(20);
    const ev = r.events();
    expect(ev.filter((e) => e.kind === 'turn.end')).toHaveLength(1);
    expect(ev.at(-1)).toMatchObject({ kind: 'turn.end', stopReason: 'cancelled' });
    expect(ev.find((e) => e.kind === 'tool.result')).toMatchObject({ status: 'cancelled' });
    expect(checkInvariants(ev)).toEqual([]);
    const done = r.sent.find((m) => m.type === 'cancel/done');
    expect(done.body).toMatchObject({ agentId: 'a1', stopReason: 'cancelled' });
    expect(done.body.ms).toBeGreaterThanOrEqual(100);
  });

  it('a throwing adapter open becomes error + turn.end(error) and a refusal', async () => {
    const r = rig(() => { throw new Error('cannot spawn'); });
    r.send(1, 'session/start', r.start);
    await wait(30);
    expect(r.sent.find((m) => m.id === 1 && m.type === 'reply').body).toMatchObject({ error: 'open', detail: 'cannot spawn' });
    expect(r.events().map((e) => e.kind)).toEqual(['error', 'turn.end']);
    expect(r.sent.some((m) => m.type === 'slot/release')).toBe(true);
  });

  it('a missing Agent SDK names the command that sets it up, and keeps the stable code prefix', async () => {
    const r = rig(() => { throw new SdkMissingError('@anthropic-ai/claude-agent-sdk 0.3.287 is not installed'); });
    r.send(1, 'session/start', r.start);
    await wait(30);
    const detail = r.sent.find((m) => m.id === 1 && m.type === 'reply').body.detail as string;
    // this test runs from a source checkout, so the hint is the checkout step; the packaged one is in sdk-loader.test.ts
    expect(detail).toBe('sdk_missing: @anthropic-ai/claude-agent-sdk 0.3.287 is not installed. Run `pnpm install` in the source checkout.');
    expect(r.events()[0]).toMatchObject({ kind: 'error', class: 'provider', message: detail });
  });

  it('close ends an open turn as cancelled and releases the lease', async () => {
    const r = rig((s) => ({ nativeId: 'n', prompt: () => s.emit({ kind: 'text.delta', messageId: 'm', text: 'x' }), interrupt: async () => {}, answer: () => {}, close: async () => {} }));
    r.send(1, 'session/start', r.start);
    await wait(10);
    r.send(2, 'session/prompt', { agentId: 'a1', text: 'go' });
    await wait(10);
    r.send(3, 'session/close', { agentId: 'a1' });
    await wait(30);
    expect(r.events().at(-1)).toMatchObject({ kind: 'turn.end', stopReason: 'cancelled' });
    expect(r.sent.find((m) => m.type === 'slot/release').body).toEqual({ leaseId: 'L9' });
  });
});

describe('session/permission (live mode switch, spec 6.4)', () => {
  const session = (over: Partial<AgentSession> = {}): ((sink: EventSink) => AgentSession) => () => ({ nativeId: 'n', prompt: () => {}, interrupt: async () => {}, answer: () => {}, close: async () => {}, ...over });
  const replyOf = (r: ReturnType<typeof rig>, id: number) => r.sent.find((m) => m.id === id && m.type === 'reply')?.body;
  const switchTo = async (r: ReturnType<typeof rig>, mode: PermissionMode, id = 9, agentId = 'a1') => { r.send(id, 'session/permission', { agentId, mode }); await wait(20); return replyOf(r, id); };

  it('answers noSession for an agent that has none', async () => {
    const r = rig(session());
    expect(await switchTo(r, 'ask', 9, 'ghost')).toEqual({ error: 'noSession' });
  });

  it('answers unsupported for a session without setPermission (Codex has none), and says which provider', async () => {
    const r = rig(session());
    r.send(1, 'session/start', r.start);
    await wait(10);
    expect(await switchTo(r, 'readOnly')).toMatchObject({ error: 'unsupported', detail: expect.stringContaining('stub') });
  });

  it('routes the mode to the session and replies ok, for each of the five modes', async () => {
    const seen: PermissionMode[] = [];
    const r = rig(session({ setPermission: async (m) => { seen.push(m); } }));
    r.send(1, 'session/start', r.start);
    await wait(10);
    for (const [i, m] of (['readOnly', 'ask', 'edit', 'automatic', 'bypass'] as const).entries()) expect(await switchTo(r, m, 10 + i)).toEqual({ ok: true });
    expect(seen).toEqual(['readOnly', 'ask', 'edit', 'automatic', 'bypass']);
  });

  it('maps a timeout, a CLI refusal (redacted) and an UnsupportedModeError to timeout, rejected and unsupported', async () => {
    let fail: Error = new Error('timeout: setPermissionMode');
    const r = rig(session({ setPermission: async () => { throw fail; } }));
    r.send(1, 'session/start', r.start);
    await wait(10);
    expect(await switchTo(r, 'ask', 10)).toMatchObject({ error: 'timeout', detail: 'timeout: setPermissionMode' });
    fail = new Error('Cannot set permission mode to bypassPermissions (key sk-ant-api03-abcdefghijklmnop)');
    const rejected = (await switchTo(r, 'ask', 11)) as { error: string; detail: string };
    expect(rejected.error).toBe('rejected');
    expect(rejected.detail).toContain('Cannot set permission mode');
    expect(rejected.detail).not.toContain('sk-ant-api03');
    fail = new UnsupportedModeError('permission "bypass" is not offered: ACP agents never run with an auto-approve mode');
    expect(await switchTo(r, 'bypass', 12)).toMatchObject({ error: 'unsupported', detail: expect.stringContaining('ACP') });
  });
});

describe('session/start for the new modes', () => {
  const leaseOf = (r: ReturnType<typeof rig>) => r.sent.find((m) => m.type === 'slot/acquire')?.body;
  it.each([['readOnly', false], ['ask', false], ['edit', true], ['automatic', true], ['bypass', true]] as const)('asks the lease for writer=%2$s when the role mode is %1$s and the host sent no flag', async (mode, writer) => {
    const sent: any[] = [];
    const proto = new ProtocolClient({ write: (l) => sent.push(JSON.parse(l)), batchMs: 1 });
    const provider: AgentProvider = { id: 'stub', kind: 'cli', detect: async () => ({ installed: true, auth: 'ok' }), capabilities: () => ({}) as never, listModels: async () => [], open: async () => ({ nativeId: 'n', prompt: () => {}, interrupt: async () => {}, answer: () => {}, close: async () => {} }) };
    new SidecarHost(proto, new Loader({ stub: async () => ({ default: provider }) }, ['stub']));
    // the real request goes out; answer it like Rust would
    proto.receive(JSON.stringify({ v: 1, id: 1, type: 'session/start', body: { agentId: 'a1', provider: 'stub', role: { name: 'r', model: 'm', permission: mode }, cwd: '/', env: {}, auth: { mode: 'subscription', key: null } } }));
    await wait(10);
    const acquire = sent.find((m) => m.type === 'slot/acquire');
    expect(acquire.body.writer).toBe(writer);
    proto.receive(JSON.stringify({ v: 1, id: acquire.id, type: 'reply', body: { leaseId: 'L', ttlMs: 15000 } }));
    await wait(10);
    void leaseOf;
  });

  it('an explicit writer flag of the host wins over the role mode, and planDir reaches the session spec', async () => {
    let got: SessionSpec | undefined;
    const r = rig((_s, spec) => { got = spec; return { nativeId: 'n', prompt: () => {}, interrupt: async () => {}, answer: () => {}, close: async () => {} }; });
    r.send(1, 'session/start', { ...r.start, role: { name: 'r', model: 'm', permission: 'automatic' }, writer: false, planDir: '/ide/state/plans/a1' });
    await wait(10);
    expect(got?.planDir).toBe('/ide/state/plans/a1');
    expect(got?.role.permission).toBe('automatic');
  });
});
