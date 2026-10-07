import type { EventKind } from "./generated/events";

// Mirrors crates/agent_core/src/sidecar.rs; protocol.test.ts compares them with fixtures/constants.json.
export const PROTOCOL_VERSION = 1;
export const HEARTBEAT_MS = 2000;
/** No policy reply within this time means deny. */
export const POLICY_REPLY_TIMEOUT_MS = 2000;
export const LEASE_TTL_MS = 15_000;
export const BATCH_MAX_EVENTS = 64;
export const BATCH_MAX_MS = 33;
export const CANCEL_SOFT_MS = 5000;
export const CANCEL_TERM_MS = 3000;

export type EventKindName = EventKind["kind"];

// A Record keyed by every kind: adding a kind in Rust breaks the build here until it is listed.
const KIND_SET: Record<EventKindName, true> = {
  "session.started": true,
  "user.message": true,
  "text.delta": true,
  "text.done": true,
  "thinking.delta": true,
  "tool.start": true,
  "tool.update": true,
  "tool.result": true,
  "permission.request": true,
  "permission.resolved": true,
  "question.request": true,
  plan: true,
  usage: true,
  status: true,
  error: true,
  "turn.end": true,
  "session.info": true,
  note: true,
};

export const ALL_KINDS = Object.keys(KIND_SET) as EventKindName[];
