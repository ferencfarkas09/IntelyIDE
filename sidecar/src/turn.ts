// Turn bookkeeping shared by every adapter (providers-plan 1.5 invariants, 5.6 cancel):
// strictly increasing seq, every tool.start ends in a tool.result, exactly one turn.end per turn,
// pending permissions resolve "cancelled" and open tools get a synthesized "cancelled" result on cancel.
import type { DecidedBy, EventInput, EventSink, StopReason, WireEvent } from './types.js';

export type WireSink = (ev: WireEvent) => void;

/** Assigns seq/ts and forwards gap-free events to the wire (or to a test collector). */
export class SeqSink implements EventSink {
  private seq: number;
  constructor(private out: WireSink, startSeq = 1, private now: () => number = Date.now) { this.seq = startSeq; }
  get nextSeq(): number { return this.seq; }
  emit(e: EventInput): void { this.out({ ...e, seq: this.seq++, ts: this.now() } as WireEvent); }
}

export class TurnGuard implements EventSink {
  private turn = 0;
  private turnId: string | undefined;
  private tools = new Set<string>();
  private closedTools = new Set<string>();
  private perms = new Set<string>();
  private open = false;

  /** `idPrefix` keeps turn ids unique across the sessions of one run: a resumed session must not reuse `turn-1`. */
  constructor(private inner: EventSink, private idPrefix = 'turn-') {}

  get turnOpen(): boolean { return this.open; }
  get currentTurnId(): string | undefined { return this.turnId; }

  beginTurn(): string {
    if (this.open) this.endTurn('error');
    this.turnId = `${this.idPrefix}${++this.turn}`;
    this.open = true;
    return this.turnId;
  }

  emit(e: EventInput): void {
    if (e.kind === 'error' && !this.open) this.beginTurn(); // a session that dies while idle still reports error + turn.end(error)
    const inTurn = this.open;
    switch (e.kind) {
      case 'tool.start': this.tools.add(e.toolId); this.closedTools.delete(e.toolId); break;
      case 'tool.result':
        if (!this.tools.has(e.toolId)) return; // late result after a synthesized cancel, or never started: dropped
        this.tools.delete(e.toolId); this.closedTools.add(e.toolId);
        break;
      case 'tool.update': if (!this.tools.has(e.toolId)) return; break;
      case 'permission.request': this.perms.add(e.reqId); break;
      case 'permission.resolved':
        if (!this.perms.has(e.reqId)) return; // already resolved (cancelled)
        this.perms.delete(e.reqId);
        break;
      case 'turn.end':
        if (!this.open) return; // exactly one turn.end per turn
        this.settle('user');
        this.open = false;
        break;
      default:
    }
    this.inner.emit(inTurn && e.turnId === undefined && e.kind !== 'session.info' ? ({ ...e, turnId: this.turnId } as EventInput) : e);
  }

  /** Ends the turn: unresolved permissions -> cancelled, open tools -> cancelled results, then one turn.end. */
  endTurn(stopReason: StopReason): void {
    if (!this.open) return;
    this.emit({ kind: 'turn.end', stopReason });
  }

  private settle(by: DecidedBy): void {
    const id = this.turnId;
    for (const reqId of [...this.perms]) { this.perms.delete(reqId); this.inner.emit({ kind: 'permission.resolved', reqId, outcome: 'cancelled', by, turnId: id }); }
    for (const toolId of [...this.tools]) { this.tools.delete(toolId); this.closedTools.add(toolId); this.inner.emit({ kind: 'tool.result', toolId, status: 'cancelled', turnId: id }); }
  }
}

// `note` is outside the turn bookkeeping: a note the turn could no longer deliver is reported (dropped) around the turn's end
const NON_TURN = new Set(['session.started', 'session.info', 'status', 'usage', 'note']);

/** Invariant checker used by golden and mock tests (mirrors agent_core invariants.rs). Returns violations. */
export function checkInvariants(events: ReadonlyArray<{ seq: number; kind: string } & Record<string, any>>): string[] {
  const bad: string[] = [];
  let last = 0;
  const tools = new Set<string>();
  const perms = new Set<string>();
  let turnOpen = false;
  for (const e of events) {
    if (typeof e.seq !== 'number' || e.seq <= last) bad.push(`seq not strictly increasing at ${e.seq} after ${last}`);
    else if (last && e.seq !== last + 1) bad.push(`seq gap: ${last} -> ${e.seq}`);
    last = e.seq;
    if (e.kind === 'turn.end') {
      if (!turnOpen) bad.push(`turn.end without an open turn at seq ${e.seq}`);
      if (tools.size) bad.push(`turn.end with open tools: ${[...tools].join(',')}`);
      if (perms.size) bad.push(`turn.end with pending permissions: ${[...perms].join(',')}`);
      turnOpen = false;
      continue;
    }
    if (!NON_TURN.has(e.kind)) turnOpen = true;
    if (e.kind === 'tool.start') tools.add(e.toolId);
    if (e.kind === 'tool.result' && !tools.delete(e.toolId)) bad.push(`tool.result without tool.start: ${e.toolId}`);
    if (e.kind === 'permission.request') perms.add(e.reqId);
    if (e.kind === 'permission.resolved' && !perms.delete(e.reqId)) bad.push(`permission.resolved without request: ${e.reqId}`);
  }
  if (turnOpen) bad.push('turn never ended');
  return bad;
}
