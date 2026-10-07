import { describe, expect, it } from 'vitest';
import { checkInvariants, SeqSink, TurnGuard } from '../src/turn.js';
import type { WireEvent } from '../src/types.js';

function rig() {
  const out: WireEvent[] = [];
  const guard = new TurnGuard(new SeqSink((e) => out.push(e), 1, () => 0));
  return { out, guard };
}

describe('TurnGuard', () => {
  it('assigns gap-free seq and the turn id', () => {
    const { out, guard } = rig();
    guard.emit({ kind: 'session.info', nativeId: 'n' });
    guard.beginTurn();
    guard.emit({ kind: 'text.delta', messageId: 'm', text: 'a' });
    guard.endTurn('endTurn');
    expect(out.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(out[0].turnId).toBeUndefined();
    expect(out[1].turnId).toBe('turn-1');
    expect(checkInvariants(out)).toEqual([]);
  });

  it('cancel synthesizes cancelled tool results and permission resolutions before the single turn.end', () => {
    const { out, guard } = rig();
    guard.beginTurn();
    guard.emit({ kind: 'tool.start', toolId: 't1', name: 'Bash', toolKind: 'exec', input: {} });
    guard.emit({ kind: 'tool.start', toolId: 't2', name: 'Read', toolKind: 'read', input: {} });
    guard.emit({ kind: 'permission.request', reqId: 'r1', toolId: 't1', intent: { class: 'exec', summary: 's' }, options: ['allow_once', 'deny'] });
    guard.endTurn('cancelled');
    guard.endTurn('cancelled'); // a second end is a no-op
    guard.emit({ kind: 'turn.end', stopReason: 'endTurn' });
    const tail = out.slice(-4).map((e) => `${e.kind}${'status' in e ? `=${e.status}` : ''}${'outcome' in e ? `=${e.outcome}` : ''}`);
    expect(tail).toEqual(['permission.resolved=cancelled', 'tool.result=cancelled', 'tool.result=cancelled', 'turn.end']);
    expect(out.filter((e) => e.kind === 'turn.end')).toHaveLength(1);
    expect(checkInvariants(out)).toEqual([]);
  });

  it('drops a late tool result after the cancel and a duplicate permission resolution', () => {
    const { out, guard } = rig();
    guard.beginTurn();
    guard.emit({ kind: 'tool.start', toolId: 't1', name: 'Bash', toolKind: 'exec', input: {} });
    guard.endTurn('cancelled');
    const n = out.length;
    guard.emit({ kind: 'tool.result', toolId: 't1', status: 'ok' });
    guard.emit({ kind: 'tool.update', toolId: 't1', status: 'running' });
    guard.emit({ kind: 'permission.resolved', reqId: 'nope', outcome: 'allow', by: 'user' });
    expect(out.length).toBe(n);
  });

  it('a new turn closes a forgotten one with error', () => {
    const { out, guard } = rig();
    guard.beginTurn();
    guard.beginTurn();
    expect(out.map((e) => e.kind)).toEqual(['turn.end']);
    expect(out[0]).toMatchObject({ stopReason: 'error' });
  });
});

describe('TurnGuard: failure while idle', () => {
  it('error then turn.end(error) form a valid turn of their own', () => {
    const { out, guard } = rig();
    guard.emit({ kind: 'error', class: 'provider', message: 'claude process ended', retryable: false });
    guard.emit({ kind: 'turn.end', stopReason: 'error' });
    expect(out.map((e) => e.kind)).toEqual(['error', 'turn.end']);
    expect(checkInvariants(out)).toEqual([]);
  });
});

describe('checkInvariants', () => {
  it('flags every violation kind', () => {
    const bad = checkInvariants([
      { seq: 1, kind: 'tool.result', toolId: 'x' },
      { seq: 3, kind: 'tool.start', toolId: 'y' },
      { seq: 3, kind: 'turn.end' },
      { seq: 4, kind: 'turn.end' },
    ]).join('\n');
    for (const n of ['without tool.start', 'seq gap', 'strictly increasing', 'open tools', 'without an open turn']) expect(bad).toContain(n);
  });
});
