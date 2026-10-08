import type { EventKindName } from "./constants";
import type { AgentEvent } from "./generated/events";

export class ProtocolError extends Error {}

type Field = "string" | "number" | "boolean" | "object" | "array" | "any";
/** `x?` may be absent or null. */
type Spec = Record<string, Field | `${Field}?`>;

// Required payload fields per kind. Keyed by every kind so a new Rust kind breaks the build until it is described.
const PAYLOAD: Record<EventKindName, Spec> = {
  "session.started": { model: "string", effective: "object", nativeId: "string?", auth: "object?", assertions: "array?", capsDelta: "object?" },
  "user.message": { messageId: "string", text: "string" },
  "text.delta": { messageId: "string", text: "string", parentToolId: "string?" },
  "text.done": { messageId: "string", text: "string", parentToolId: "string?" },
  "thinking.delta": { messageId: "string", text: "string", parentToolId: "string?" },
  "tool.start": { toolId: "string", name: "string", toolKind: "string", input: "any", parentToolId: "string?" },
  "tool.update": { toolId: "string", status: "string", output: "string?" },
  "tool.result": { toolId: "string", status: "string", output: "string?", diff: "object?", durationMs: "number?" },
  "permission.request": { reqId: "string", toolId: "string", intent: "object", options: "array?", sessionAllow: "object?", plan: "string?", planTruncated: "boolean?", modes: "array?" },
  "permission.resolved": { reqId: "string", outcome: "string", by: "string" },
  "question.request": { reqId: "string", toolId: "string?", prompt: "string", options: "array?" },
  plan: { items: "array" },
  usage: { usage: "object" },
  status: { state: "string", retryAfterMs: "number?", scope: "string?" },
  error: { class: "string", message: "string", retryable: "boolean" },
  "turn.end": { stopReason: "string" },
  "session.info": { title: "string?", nativeId: "string?", models: "array?", caps: "object?", effective: "object?", delegates: "array?" },
  note: { noteId: "string", state: "string", parentToolId: "string?", text: "string?", toolId: "string?", reason: "string?" },
};

const ENVELOPE: Spec = { agentId: "string", seq: "number", ts: "number", provider: "string", turnId: "string?", raw: "any?" };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function matches(value: unknown, field: Field): boolean {
  switch (field) {
    case "any":
      return true;
    case "array":
      return Array.isArray(value);
    case "object":
      return isObject(value);
    default:
      return typeof value === field;
  }
}

function checkSpec(obj: Record<string, unknown>, spec: Spec, where: string): void {
  for (const [key, type] of Object.entries(spec)) {
    const optional = type.endsWith("?");
    const field = (optional ? type.slice(0, -1) : type) as Field;
    const has = Object.hasOwn(obj, key);
    if (optional && (!has || obj[key] === null)) continue;
    if (!has) throw new ProtocolError(`${where}: missing field "${key}"`);
    if (!matches(obj[key], field)) throw new ProtocolError(`${where}: field "${key}" is not a ${field}`);
  }
}

/** Validates the envelope and the required payload fields of one event; throws `ProtocolError`. */
export function parseAgentEvent(input: unknown): AgentEvent {
  if (!isObject(input)) throw new ProtocolError("event is not an object");
  checkSpec(input, ENVELOPE, "event");
  if (!Number.isInteger(input.seq) || (input.seq as number) < 0) throw new ProtocolError('event: "seq" must be a non-negative integer');
  const kind = input.kind;
  if (typeof kind !== "string" || !Object.hasOwn(PAYLOAD, kind)) throw new ProtocolError(`event: unknown kind ${JSON.stringify(kind)}`);
  checkSpec(input, PAYLOAD[kind as EventKindName], kind);
  return input as unknown as AgentEvent;
}

/** One NDJSON line (the JSONL run log). */
export function parseEventLine(line: string): AgentEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (e) {
    throw new ProtocolError(`event line is not JSON: ${(e as Error).message}`);
  }
  return parseAgentEvent(value);
}
