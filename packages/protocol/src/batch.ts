import type { AgentEvent, BatchEvent } from "./generated/events";

/** `events/batch` carries `agentId` and `provider` once; the stored / displayed event has them on every event. */
export function eventsOfBatch(body: { agentId: string; provider: string; events: BatchEvent[] }): AgentEvent[] {
  return body.events.map((e) => ({ ...e, agentId: body.agentId, provider: body.provider }) as AgentEvent);
}

/** The reverse: drops the batch-level fields (`seq`, `ts`, `turnId`, payload and `raw` stay). */
export function toBatchEvent(e: AgentEvent): BatchEvent {
  const { agentId: _agentId, provider: _provider, ...rest } = e;
  return rest as BatchEvent;
}
