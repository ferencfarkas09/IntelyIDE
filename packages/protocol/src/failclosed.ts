// Fail closed (providers-plan 5.5): no reply within POLICY_REPLY_TIMEOUT_MS, a malformed reply or a closed pipe
// means deny. The hook / ACP / Codex adapters ask through `decideOrDeny` and never decide anything themselves.
import { POLICY_REPLY_TIMEOUT_MS } from "./constants";
import type { DecidedBy } from "./generated/events";
import type { Decision, PolicyDecision, PolicyRequest } from "./generated/policy";
import type { Reply } from "./generated/sidecar";

// Records keyed by every value: a new variant in Rust breaks the build until it is listed.
const DECISIONS: Record<Decision, true> = { allow: true, deny: true, ask: true };
const DECIDED_BY: Record<DecidedBy, true> = { hardStop: true, roleDeny: true, saved: true, user: true, default: true, failClosed: true };

export function failClosed(reason: string): PolicyDecision {
  return { decision: "deny", by: "failClosed", reason, rule: "fail-closed" };
}

/** A well-formed decision, or `null`. */
export function parsePolicyDecision(value: unknown): PolicyDecision | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const ok =
    typeof v.decision === "string" &&
    Object.hasOwn(DECISIONS, v.decision) &&
    typeof v.by === "string" &&
    Object.hasOwn(DECIDED_BY, v.by) &&
    typeof v.reason === "string" &&
    (v.rule === undefined || v.rule === null || typeof v.rule === "string");
  return ok ? (v as unknown as PolicyDecision) : null;
}

export type PolicySender = (request: PolicyRequest) => Promise<unknown>;

/** Asks Rust to judge a tool call; every failure mode is a denial. */
export async function decideOrDeny(send: PolicySender, request: PolicyRequest, timeoutMs = POLICY_REPLY_TIMEOUT_MS): Promise<PolicyDecision> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no policy reply within ${timeoutMs} ms`)), timeoutMs);
    });
    const reply = await Promise.race([send(request), timeout]);
    return parsePolicyDecision(reply) ?? failClosed("malformed policy reply");
  } catch (e) {
    return failClosed(e instanceof Error ? e.message : "policy channel failed");
  } finally {
    clearTimeout(timer);
  }
}

/** Which shape a `reply` body has (replies are matched to requests by id and carry no type). */
export function replyKind(reply: Reply): "error" | "decision" | "lease" | "started" | "ack" {
  if ("error" in reply) return "error";
  if ("decision" in reply) return "decision";
  if ("leaseId" in reply) return "lease";
  if ("nativeId" in reply) return "started";
  return "ack";
}
