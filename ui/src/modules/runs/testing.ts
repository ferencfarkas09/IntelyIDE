import { emptyView, reduceEvents, type AgentView } from "../../store/agent-reducer";
import type { AgentRow } from "../../store/agents";
import type { AgentEvent, EventPayload } from "../../store/agent-types";

/** Test fixtures shared by this module's tests. */
export function row(over: Partial<AgentRow> & Pick<AgentRow, "agentId">): AgentRow {
  return {
    provider: "claude",
    role: "developer",
    model: "claude-sonnet-5-5",
    title: "Fix the order list", // i18n-ignore: test fixture
    status: "running",
    permission: "edit",
    requested: { effort: "medium", permission: "edit" },
    repoIds: ["admin"],
    caps: {} as AgentRow["caps"],
    enforcement: "bestEffort",
    startedAt: 1_000_000,
    needs: 0,
    ...over,
  };
}

export function viewOf(agentId: string, payloads: EventPayload[], ts = 1_000): AgentView {
  const events = payloads.map((p, i) => ({ agentId, seq: i + 1, ts: ts + i, provider: "claude", ...p }) as AgentEvent);
  return reduceEvents(emptyView(agentId), events);
}

export const PERMISSION: Extract<EventPayload, { kind: "permission.request" }> = {
  kind: "permission.request",
  reqId: "r1",
  toolId: "t1",
  intent: { class: "exec", summary: "Run `npm test`", paths: [] } as unknown as Extract<EventPayload, { kind: "permission.request" }>["intent"],
  options: ["allow_once", "deny"],
};
