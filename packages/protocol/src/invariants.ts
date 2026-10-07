// Mirror of crates/agent_core/src/events/invariants.rs. Both replay the cases in
// fixtures/invariant-cases.json (produced by Rust) and must report the same codes.
import type { AgentEvent, Violation, ViolationCode } from "./generated/events";

interface AgentState {
  nextSeq: number;
  lastSeq: number;
  openTools: Set<string>;
  closedTools: Set<string>;
  pendingPermissions: Set<string>;
  /** `undefined` = no turn open; `null` = open turn without an id. */
  openTurn: string | null | undefined;
  endedTurns: Set<string>;
  lastWasTurnEnd: boolean;
}

const TURN_SCOPED = new Set([
  "user.message",
  "text.delta",
  "text.done",
  "thinking.delta",
  "tool.start",
  "tool.update",
  "tool.result",
  "permission.request",
  "permission.resolved",
  "question.request",
  "plan",
]);

const join = (set: Set<string>) => [...set].sort().join(", ");

export class InvariantChecker {
  private agents = new Map<string, AgentState>();

  /** Every agent's first event must have `seq` `firstSeq` (1 unless the stream starts mid-run). */
  constructor(private firstSeq = 1) {}

  push(e: AgentEvent): Violation[] {
    let st = this.agents.get(e.agentId);
    if (!st) {
      st = {
        nextSeq: this.firstSeq,
        lastSeq: 0,
        openTools: new Set(),
        closedTools: new Set(),
        pendingPermissions: new Set(),
        openTurn: undefined,
        endedTurns: new Set(),
        lastWasTurnEnd: false,
      };
      this.agents.set(e.agentId, st);
    }
    const out: Violation[] = [];
    const bad = (code: ViolationCode, detail: string) => out.push({ agentId: e.agentId, seq: e.seq, code, detail });

    if (e.seq !== st.nextSeq) {
      bad(e.seq > st.nextSeq ? "seqGap" : "seqRepeat", `expected seq ${st.nextSeq}, got ${e.seq}`);
    }
    st.nextSeq = e.seq + 1;
    st.lastSeq = e.seq;

    const turnId = e.turnId ?? null;
    const scoped = TURN_SCOPED.has(e.kind);
    if (scoped && turnId !== null && st.endedTurns.has(turnId)) {
      bad("eventAfterTurnEnd", `${e.kind} after turn ${turnId} ended`);
    } else if (scoped) {
      if (st.openTurn === undefined) {
        st.openTurn = turnId;
      } else if (turnId !== null && st.openTurn !== null && st.openTurn !== turnId) {
        bad("missingTurnEnd", `turn ${st.openTurn} never ended before ${turnId} started`);
        st.openTurn = turnId;
      }
      st.lastWasTurnEnd = false;
    }

    switch (e.kind) {
      case "tool.start":
        if (st.openTools.has(e.toolId) || st.closedTools.has(e.toolId)) {
          bad("toolStartDuplicate", `tool ${e.toolId} started twice`);
        } else {
          st.openTools.add(e.toolId);
        }
        break;
      case "tool.update":
        if (!st.openTools.has(e.toolId)) bad("toolResultWithoutStart", `tool.update for unknown tool ${e.toolId}`);
        break;
      case "tool.result":
        if (st.openTools.delete(e.toolId)) st.closedTools.add(e.toolId);
        else bad("toolResultWithoutStart", `tool.result for unknown tool ${e.toolId}`);
        break;
      case "permission.request":
        st.pendingPermissions.add(e.reqId);
        break;
      case "permission.resolved":
        if (!st.pendingPermissions.delete(e.reqId)) {
          bad("resolvedWithoutRequest", `permission.resolved for unknown request ${e.reqId}`);
        }
        break;
      case "turn.end": {
        const repeated = (turnId !== null && st.endedTurns.has(turnId)) || (st.lastWasTurnEnd && st.openTurn === undefined);
        if (repeated) bad("duplicateTurnEnd", "turn.end twice for one turn");
        if (st.openTools.size > 0) {
          bad("toolUnclosed", `tools still open at turn end: ${join(st.openTools)}`);
          st.openTools.forEach((t) => st.closedTools.add(t));
          st.openTools.clear();
        }
        if (st.pendingPermissions.size > 0) {
          bad("permissionUnresolved", `permission requests still pending at turn end: ${join(st.pendingPermissions)}`);
          st.pendingPermissions.clear();
        }
        if (turnId !== null) st.endedTurns.add(turnId);
        st.openTurn = undefined;
        st.lastWasTurnEnd = true;
        break;
      }
      default:
        break;
    }
    return out;
  }

  /** End of stream: anything still open is a violation. */
  finish(): Violation[] {
    const out: Violation[] = [];
    for (const agentId of [...this.agents.keys()].sort()) {
      const st = this.agents.get(agentId)!;
      const bad = (code: ViolationCode, detail: string) => out.push({ agentId, seq: st.lastSeq, code, detail });
      if (st.openTurn !== undefined) bad("missingTurnEnd", `turn ${st.openTurn ?? "(unnamed)"} has no turn.end`);
      if (st.openTools.size > 0) bad("toolUnclosed", `tools never closed: ${join(st.openTools)}`);
      if (st.pendingPermissions.size > 0) bad("permissionUnresolved", `permission requests never resolved: ${join(st.pendingPermissions)}`);
    }
    return out;
  }
}

/** Checks a whole stream (events of several agents may be interleaved). */
export function check(events: readonly AgentEvent[]): Violation[] {
  const checker = new InvariantChecker();
  const out = events.flatMap((e) => checker.push(e));
  return [...out, ...checker.finish()];
}
