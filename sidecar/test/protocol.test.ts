import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtocolClient } from '../src/protocol.js';
import { checkInvariants } from '../src/turn.js';
import type { WireEvent } from '../src/types.js';

const policyReq = { agentId: 'a1', toolId: 't9', provider: 'claude', intent: { class: 'exec' as const, rawCommand: '/usr/bin/git push origin HEAD', summary: 'push' } };

function pair(opts: ConstructorParameters<typeof ProtocolClient>[0] extends infer O ? Partial<O> : never = {}) {
  const sent: any[] = [];
  const c = new ProtocolClient({ write: (l) => sent.push(JSON.parse(l)), ...opts });
  const reply = (id: number, body: unknown) => c.receive(JSON.stringify({ v: 1, id, type: 'reply', body }));
  return { c, sent, reply };
}

describe('policy/decide fails closed (providers-plan 5.5)', () => {
  it('passes a well-formed reply through', async () => {
    const { c, sent, reply } = pair();
    const p = c.decide(policyReq);
    expect(sent[0]).toMatchObject({ v: 1, type: 'policy/decide', body: policyReq });
    reply(sent[0].id, { decision: 'deny', by: 'hardStop', reason: 'git push is human-only' });
    expect(await p).toEqual({ decision: 'deny', by: 'hardStop', reason: 'git push is human-only' });
  });

  it('keeps the rule id of the reply (the Inspector shows which rule refused)', async () => {
    const { c, sent, reply } = pair();
    const p = c.decide(policyReq);
    reply(sent[0].id, { decision: 'deny', by: 'roleDeny', reason: 'Edit is not one of researcher\'s tools', rule: 'role.tool-not-allowed' });
    expect(await p).toEqual({ decision: 'deny', by: 'roleDeny', reason: 'Edit is not one of researcher\'s tools', rule: 'role.tool-not-allowed' });
    const q = c.decide(policyReq);
    reply(sent[1].id, { decision: 'allow', by: 'default', reason: 'x', rule: null });
    expect(await q).toEqual({ decision: 'allow', by: 'default', reason: 'x' });
  });

  it('keeps the session allow offer of an Ask (without it the "Allow always in this session" button never appeared)', async () => {
    const { c, sent, reply } = pair();
    const p = c.decide(policyReq);
    reply(sent[0].id, { decision: 'ask', by: 'default', reason: 'commands need approval unless saved', rule: 'exec.ask', sessionAllow: { kind: 'exec', scope: 'echo' } });
    expect(await p).toEqual({ decision: 'ask', by: 'default', reason: 'commands need approval unless saved', rule: 'exec.ask', sessionAllow: { kind: 'exec', scope: 'echo' } });
    // a malformed offer is dropped, the decision itself stands
    const q = c.decide(policyReq);
    reply(sent[1].id, { decision: 'ask', by: 'default', sessionAllow: { kind: 'shell', scope: 5 } });
    expect(await q).toEqual({ decision: 'ask', by: 'default' });
    const r = c.decide(policyReq);
    reply(sent[2].id, { decision: 'ask', by: 'default', sessionAllow: null });
    expect(await r).toEqual({ decision: 'ask', by: 'default' });
  });

  it('denies when no reply arrives within the timeout', async () => {
    const { c } = pair({ policyTimeoutMs: 40 });
    const t0 = Date.now();
    const d = await c.decide(policyReq);
    expect(d).toMatchObject({ decision: 'deny', by: 'failClosed' });
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('defaults to a 2 s timeout', async () => {
    vi.useFakeTimers();
    const { c } = pair();
    const p = c.decide(policyReq);
    await vi.advanceTimersByTimeAsync(1999);
    let settled = false;
    void p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await p).toMatchObject({ decision: 'deny', by: 'failClosed' });
    vi.useRealTimers();
  });

  it.each([[{ nonsense: true }], [{ decision: 'maybe', by: 'x' }], [{ decision: 'allow' }], ['allow'], [null], [42]])('denies a malformed reply %j', async (bad) => {
    const { c, sent, reply } = pair();
    const p = c.decide(policyReq);
    reply(sent[0].id, bad);
    expect(await p).toMatchObject({ decision: 'deny', by: 'failClosed' });
  });

  it('denies when the pipe closes mid-request and after it is closed', async () => {
    const { c } = pair();
    const p = c.decide(policyReq);
    c.close();
    expect(await p).toMatchObject({ decision: 'deny', by: 'failClosed' });
    expect(await c.decide(policyReq)).toMatchObject({ decision: 'deny', by: 'failClosed' });
  });

  it('denies when the write itself fails (broken pipe)', async () => {
    const c = new ProtocolClient({ write: () => { throw new Error('EPIPE'); } });
    expect(await c.decide(policyReq)).toMatchObject({ decision: 'deny', by: 'failClosed' });
  });

  it('ignores garbage lines without crashing', () => {
    const { c } = pair();
    for (const l of ['', '{{', 'null', '{"v":2,"id":1,"type":"x"}', '{"v":1,"type":"reply"}']) c.receive(l);
    expect(c.garbageLines).toBe(4);
  });
});

describe('events/batch', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const ev = (seq: number): WireEvent => ({ seq, ts: seq, kind: 'text.delta', messageId: 'm', text: 'x' });

  it('flushes after 33 ms', () => {
    const { c, sent } = pair();
    c.emit('a1', 'claude', ev(1));
    c.emit('a1', 'claude', ev(2));
    vi.advanceTimersByTime(32);
    expect(sent.length).toBe(0);
    vi.advanceTimersByTime(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'events/batch', body: { agentId: 'a1', provider: 'claude' } });
    expect(sent[0].body.events.map((e: WireEvent) => e.seq)).toEqual([1, 2]);
  });

  it('flushes at 64 events and keeps order across batches', () => {
    const { c, sent } = pair();
    for (let i = 1; i <= 130; i++) c.emit('a1', 'claude', ev(i));
    expect(sent.map((s) => s.body.events.length)).toEqual([64, 64]);
    vi.advanceTimersByTime(40);
    const all = sent.flatMap((s) => s.body.events as WireEvent[]);
    expect(all.map((e) => e.seq)).toEqual(Array.from({ length: 130 }, (_, i) => i + 1));
    expect(checkInvariants(all.map((e) => ({ ...e, kind: 'text.delta' })))).toEqual(['turn never ended']);
  });

  it('batches per agent', () => {
    const { c, sent } = pair();
    c.emit('a1', 'claude', ev(1));
    c.emit('a2', 'mock', ev(1));
    vi.advanceTimersByTime(40);
    expect(sent.map((s) => s.body.agentId).sort()).toEqual(['a1', 'a2']);
  });

  it('the invariant checker flags a seq gap', () => {
    const bad = checkInvariants([{ seq: 1, kind: 'text.delta' }, { seq: 3, kind: 'turn.end' }]);
    expect(bad.join()).toContain('seq gap: 1 -> 3');
  });

  it('close() flushes what is queued', () => {
    const { c, sent } = pair();
    c.emit('a1', 'claude', ev(1));
    c.close();
    expect(sent).toHaveLength(1);
  });
});

describe('hello and heartbeat', () => {
  it('sends hello, then a heartbeat every 2 s', () => {
    vi.useFakeTimers();
    const { c, sent } = pair({ heartbeatBody: () => ({ pid: 7, loaded: [], sessions: 0 }) });
    c.start({ pid: 7, version: '1', node: 'v24', providers: ['claude'] });
    expect(sent.map((s) => s.type)).toEqual(['hello']);
    vi.advanceTimersByTime(6100);
    expect(sent.filter((s) => s.type === 'heartbeat')).toHaveLength(3);
    c.close();
    vi.advanceTimersByTime(5000);
    expect(sent.filter((s) => s.type === 'heartbeat')).toHaveLength(3);
    vi.useRealTimers();
  });
});

describe('inbound requests', () => {
  it('replies to handlers, reports handler errors and unknown types', async () => {
    const { c, sent } = pair();
    c.on('session/prompt', (b) => ({ ok: true, echo: b.text }));
    c.on('session/close', () => { throw new Error('boom'); });
    c.receive(JSON.stringify({ v: 1, id: 5, type: 'session/prompt', body: { text: 'hi' } }));
    c.receive(JSON.stringify({ v: 1, id: 6, type: 'session/close', body: {} }));
    c.receive(JSON.stringify({ v: 1, id: 7, type: 'nope', body: {} }));
    await new Promise((r) => setTimeout(r, 10));
    const byId = Object.fromEntries(sent.map((s) => [s.id, s.body]));
    expect(byId[5]).toEqual({ ok: true, echo: 'hi' });
    expect(byId[6]).toMatchObject({ error: 'handler', detail: 'boom' });
    expect(byId[7]).toMatchObject({ error: 'unknownType' });
  });
});
