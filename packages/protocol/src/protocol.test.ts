import { afterEach, describe, expect, it, vi } from "vitest";
import constants from "../fixtures/constants.json";
import events from "../fixtures/events.json";
import intentCases from "../fixtures/intent-cases.json";
import invariantCases from "../fixtures/invariant-cases.json";
import sidecarMessages from "../fixtures/sidecar-messages.json";
import {
  ALL_KINDS,
  BATCH_MAX_EVENTS,
  BATCH_MAX_MS,
  CANCEL_SOFT_MS,
  CANCEL_TERM_MS,
  HEARTBEAT_MS,
  InvariantChecker,
  LEASE_TTL_MS,
  POLICY_REPLY_TIMEOUT_MS,
  PROTOCOL_VERSION,
  ProtocolError,
  check,
  decideOrDeny,
  eventsOfBatch,
  failClosed,
  intentFromClaudeTool,
  parseAgentEvent,
  parseEventLine,
  parsePolicyDecision,
  replyKind,
  toBatchEvent,
  type AgentEvent,
  type PolicyRequest,
  type SidecarMsg,
} from "./index";

const sample = events as unknown as AgentEvent[];

// Rust writes null / [] for an absent option / list, TypeScript may omit the key: both mean the same.
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, stripNulls(v)]));
  }
  return value;
}

describe("events written by Rust", () => {
  it("parse in TypeScript, one of every kind", () => {
    const parsed = sample.map(parseAgentEvent);
    expect(parsed.map((e) => e.kind).sort()).toEqual([...ALL_KINDS].sort());
    expect(constants.allKinds.slice().sort()).toEqual([...ALL_KINDS].sort());
  });

  it("survive a JSON line round trip", () => {
    for (const e of sample) expect(parseEventLine(JSON.stringify(e))).toEqual(e);
  });

  it("narrow by kind to the generated payload types", () => {
    const e = parseAgentEvent(sample.find((x) => x.kind === "tool.start"));
    if (e.kind !== "tool.start") throw new Error("narrowing failed");
    expect(e.toolKind).toBe("exec");
    expect(e.toolId).toBe("t9");
  });

  it("form a valid stream", () => {
    expect(check(sample)).toEqual([]);
  });
});

describe("invariant checker parity with Rust", () => {
  for (const c of invariantCases) {
    it(c.name, () => {
      const codes = check(c.events as unknown as AgentEvent[]).map((v) => v.code);
      expect(codes).toEqual(c.expect);
    });
  }

  it("can start mid-run when told so", () => {
    const checker = new InvariantChecker(6);
    const out = [...sample.slice(5).flatMap((e) => checker.push(e)), ...checker.finish()];
    expect(out).toEqual([]);
  });

  it("flags a gap once, without cascading", () => {
    const gappy = sample.filter((_, i) => i !== 3);
    expect(check(gappy).map((v) => v.code)).toEqual(["seqGap"]);
  });
});

describe("parseAgentEvent rejects", () => {
  const good = sample[1] as unknown as Record<string, unknown>;
  const cases: [string, unknown][] = [
    ["a non-object", 42],
    ["an array", []],
    ["a missing agentId", { ...good, agentId: undefined }],
    ["a string seq", { ...good, seq: "1" }],
    ["a negative seq", { ...good, seq: -1 }],
    ["a fractional seq", { ...good, seq: 1.5 }],
    ["an unknown kind", { ...good, kind: "tool.explode" }],
    ["a missing payload field", { agentId: "a", seq: 0, ts: 1, provider: "p", kind: "text.delta", messageId: "m" }],
    ["a wrongly typed payload field", { agentId: "a", seq: 0, ts: 1, provider: "p", kind: "turn.end", stopReason: 3 }],
    ["a tool.start without input", { agentId: "a", seq: 0, ts: 1, provider: "p", kind: "tool.start", toolId: "t", name: "Bash", toolKind: "exec" }],
  ];
  for (const [name, input] of cases) {
    it(name, () => expect(() => parseAgentEvent(input)).toThrow(ProtocolError));
  }

  it("accepts omitted and null optional fields", () => {
    const minimal = { agentId: "a", seq: 0, ts: 1, provider: "p", kind: "text.delta", messageId: "m", text: "x" };
    expect(parseAgentEvent(minimal)).toEqual(minimal);
    expect(parseAgentEvent({ ...minimal, turnId: null, raw: null })).toBeTruthy();
    expect(() => parseEventLine("{")).toThrow(ProtocolError);
  });
});

describe("sidecar messages written by Rust", () => {
  const messages = sidecarMessages as unknown as SidecarMsg[];
  const TYPES = [
    "hello", "heartbeat", "policy/decide", "slot/acquire", "slot/renew", "slot/release", "events/batch",
    "session/start", "session/prompt", "session/close", "session/permission", "cancel/request", "cancel/done", "permission/answer", "reply",
  ];

  it("cover every type and carry the envelope", () => {
    expect(new Set(messages.map((m) => m.type))).toEqual(new Set(TYPES));
    for (const m of messages) {
      expect(m.v).toBe(PROTOCOL_VERSION);
      expect(typeof m.id).toBe("number");
    }
  });

  it("have events that parse inside a batch", () => {
    const batch = messages.find((m) => m.type === "events/batch");
    if (batch?.type !== "events/batch") throw new Error("no batch");
    const full = eventsOfBatch(batch.body);
    expect(full.map(parseAgentEvent)).toHaveLength(2);
    expect(full.map((e) => e.agentId)).toEqual(["a1", "a1"]);
    expect(full.map(toBatchEvent)).toEqual(batch.body.events);
    expect(check(full)).toEqual([]);
  });

  it("tell the reply shapes apart", () => {
    const kinds = messages.flatMap((m) => (m.type === "reply" ? [replyKind(m.body)] : []));
    expect(kinds).toEqual(["decision", "lease", "error", "ack", "started", "ack", "error"]);
  });

  it("have a policy reply that parses as a decision", () => {
    const reply = messages.find((m) => m.type === "reply");
    expect(parsePolicyDecision(reply?.type === "reply" ? reply.body : null)).toMatchObject({ decision: "deny", by: "hardStop" });
  });
});

describe("delegation fields (spec 4.1)", () => {
  const messages = sidecarMessages as unknown as SidecarMsg[];

  it("session/start carries delegates only when there are some", () => {
    const starts = messages.flatMap((m) => (m.type === "session/start" ? [m.body] : []));
    expect(starts).toHaveLength(2);
    const [classic, auto] = starts;
    expect(classic?.delegates ?? undefined).toBeUndefined();
    expect(auto?.delegates?.map((d) => d.name)).toEqual(["researcher", "developer"]);
    expect(auto?.delegates?.[0]).toMatchObject({ permission: "readOnly", scope: "global", maxTurns: 25 });
  });

  it("policy/decide intents carry the actor and the Agent facts, and old ones still parse", () => {
    const intents = messages.flatMap((m) => (m.type === "policy/decide" ? [m.body.intent] : []));
    expect(intents.find((i) => i.actor)?.actor).toEqual({ agentId: "agent-7", role: "researcher" });
    const agent = intents.find((i) => i.subagentFlags);
    expect(agent).toMatchObject({ isolation: "worktree", subagentFlags: { hasModel: true, background: true, subagentType: "researcher" } });
    expect(intents.some((i) => i.actor === undefined && i.isolation === undefined)).toBe(true);
  });

  it("session.info and usage events carry delegates and per-model tokens", () => {
    const info = sample.find((e) => e.kind === "session.info");
    if (info?.kind !== "session.info") throw new Error("no session.info");
    expect(info.delegates?.[0]).toMatchObject({ name: "researcher", scope: "global" });
    expect(info.delegates?.[0]).not.toHaveProperty("prompt");
    const usage = sample.find((e) => e.kind === "usage");
    if (usage?.kind !== "usage") throw new Error("no usage");
    expect(usage.usage.perModel?.[0]?.model).toBe("claude-haiku-4-5-20251001");
  });

  it("a session.info and a usage event without the new fields still parse", () => {
    const base = { agentId: "a", seq: 1, ts: 1, provider: "claude" };
    expect(parseAgentEvent({ ...base, kind: "session.info", title: "t" })).toBeTruthy();
    expect(parseAgentEvent({ ...base, kind: "session.info", delegates: [] })).toBeTruthy();
    const usage = { model: "m", costBasis: "unknown", perTurn: {}, cumulative: {} };
    expect(parseAgentEvent({ ...base, kind: "usage", usage })).toBeTruthy();
  });

  it("an intent without the new fields maps without them (Bash)", () => {
    const intent = intentFromClaudeTool("Bash", { command: "ls" });
    expect(Object.keys(intent)).not.toContain("actor");
    expect(Object.keys(intent)).not.toContain("subagentFlags");
  });
});

describe("permission modes (spec 4.6, 4.7)", () => {
  const messages = sidecarMessages as unknown as SidecarMsg[];
  const base = { agentId: "a", seq: 1, ts: 1, provider: "claude" };
  const intent = { class: "other", tool: "ExitPlanMode", summary: "ExitPlanMode: leave plan mode" };

  it("session/permission carries the agent and one of the five modes, and its replies are the plain ack and error shapes", () => {
    const req = messages.find((m) => m.type === "session/permission");
    if (req?.type !== "session/permission") throw new Error("no session/permission sample");
    expect(req.body).toEqual({ agentId: "a1", mode: "automatic" });
    const replies = messages.filter((m) => m.type === "reply" && m.id >= 60);
    expect(replies.map((m) => (m.type === "reply" ? replyKind(m.body) : ""))).toEqual(["ack", "error"]);
    const err = replies[1];
    expect(err?.type === "reply" && err.body).toMatchObject({ error: "unsupported" });
  });

  it("permission/answer carries the continuation mode of an ExitPlanMode approval, and stays valid without it", () => {
    const answers = messages.flatMap((m) => (m.type === "permission/answer" ? [m.body] : []));
    expect(answers.find((a) => a.mode)).toMatchObject({ outcome: "allow", mode: "edit", reqId: "perm-t9" });
    expect(answers.some((a) => a.mode === undefined || a.mode === null)).toBe(true);
  });

  it("session/start carries the plan directory, and a classic start without it still parses", () => {
    const starts = messages.flatMap((m) => (m.type === "session/start" ? [m.body] : []));
    expect(starts.some((s) => s.planDir === "/x/plans")).toBe(true);
    expect(starts.some((s) => s.planDir == null)).toBe(true);
  });

  it("a permission.request with allow_run and a sessionAllow offer parses and narrows", () => {
    const req = sample.find((e) => e.kind === "permission.request" && e.sessionAllow);
    if (req?.kind !== "permission.request") throw new Error("no sample with a sessionAllow");
    expect(req.options).toEqual(["allow_once", "allow_run", "deny"]);
    expect(req.sessionAllow).toEqual({ kind: "exec", scope: "git status" });
    expect(parseAgentEvent(req)).toEqual(req);
  });

  it("an ExitPlanMode permission.request carries plan, planTruncated and the three modes", () => {
    const e = { ...base, kind: "permission.request", reqId: "r", toolId: "t", intent, options: ["allow_once", "deny"], plan: "# Plan", planTruncated: true, modes: ["ask", "edit", "automatic"] };
    expect(parseAgentEvent(e)).toEqual(e);
    const { modes: _modes, ...withoutModes } = e;
    expect(parseAgentEvent({ ...withoutModes, plan: null, planTruncated: null })).toBeTruthy();
    expect(() => parseAgentEvent({ ...e, plan: 7 })).toThrow(ProtocolError);
    expect(() => parseAgentEvent({ ...e, modes: "ask" })).toThrow(ProtocolError);
    expect(() => parseAgentEvent({ ...e, sessionAllow: "exec" })).toThrow(ProtocolError);
  });

  it("a session.info effective change carries the reason, and one without it still parses", () => {
    const e = { ...base, kind: "session.info", effective: { permission: "edit", reason: "planApproved" } };
    expect(parseAgentEvent(e)).toEqual(e);
    expect(parseAgentEvent({ ...base, kind: "session.info", effective: { permission: "bypass" } })).toBeTruthy();
  });

  it("the wire names of the five modes are the ones the sidecar and the UI use", () => {
    const modes = ["readOnly", "ask", "edit", "automatic", "bypass"] as const;
    const ok = modes.map((permission) => parseAgentEvent({ ...base, kind: "session.started", model: "m", effective: { permission } }));
    expect(ok).toHaveLength(5);
  });
});

describe("constants", () => {
  it("match the Rust ones", () => {
    const { allKinds: _kinds, bypassKeeps: _keeps, sdkToolCoverage: _coverage, ...rust } = constants;
    expect({
      protocolVersion: PROTOCOL_VERSION,
      heartbeatMs: HEARTBEAT_MS,
      policyReplyTimeoutMs: POLICY_REPLY_TIMEOUT_MS,
      leaseTtlMs: LEASE_TTL_MS,
      batchMaxEvents: BATCH_MAX_EVENTS,
      batchMaxMs: BATCH_MAX_MS,
      cancelSoftMs: CANCEL_SOFT_MS,
      cancelTermMs: CANCEL_TERM_MS,
    }).toEqual(rust);
  });
});

describe("Claude tool mapping parity with Rust", () => {
  for (const c of intentCases) {
    it(`${c.tool} ${JSON.stringify(c.input).slice(0, 40)}`, () => {
      expect(stripNulls(intentFromClaudeTool(c.tool, c.input as Record<string, unknown>))).toEqual(stripNulls(c.intent));
    });
  }
});

describe("fail closed", () => {
  afterEach(() => vi.useRealTimers());

  const request: PolicyRequest = {
    agentId: "a1",
    toolId: "t9",
    provider: "claude",
    intent: intentFromClaudeTool("Bash", { command: "/usr/bin/git push origin HEAD" }),
  };
  const denyReply = { decision: "deny", by: "hardStop", reason: "git push is human-only" };

  it("passes a good reply through", async () => {
    expect(await decideOrDeny(async () => denyReply, request)).toEqual(denyReply);
    const allow = { decision: "allow", by: "default", reason: "ok", rule: "read.inside" };
    expect(await decideOrDeny(async () => allow, request)).toEqual(allow);
  });

  it("denies when the channel throws or closes", async () => {
    for (const send of [async () => Promise.reject(new Error("EPIPE")), () => { throw new Error("closed"); }]) {
      const d = await decideOrDeny(send, request);
      expect(d).toMatchObject({ decision: "deny", by: "failClosed" });
    }
  });

  it("denies a malformed reply", async () => {
    const replies = [null, undefined, "allow", 1, [], {}, { decision: "allow" }, { decision: "yes", by: "user", reason: "x" }, { decision: "allow", by: "root", reason: "x" }, { decision: "allow", by: "user" }];
    for (const reply of replies) {
      const d = await decideOrDeny(async () => reply, request);
      expect(d, JSON.stringify(reply)).toMatchObject({ decision: "deny", by: "failClosed", reason: "malformed policy reply" });
    }
  });

  it("denies when no reply arrives in time", async () => {
    vi.useFakeTimers();
    const pending = decideOrDeny(() => new Promise(() => {}), request);
    await vi.advanceTimersByTimeAsync(POLICY_REPLY_TIMEOUT_MS + 1);
    expect(await pending).toMatchObject({ decision: "deny", by: "failClosed" });
  });

  it("clears its timer once the reply is in", async () => {
    vi.useFakeTimers();
    const d = decideOrDeny(async () => denyReply, request);
    await vi.advanceTimersByTimeAsync(0);
    expect(await d).toEqual(denyReply);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("builds the canonical denial", () => {
    expect(failClosed("pipe closed")).toEqual({ decision: "deny", by: "failClosed", reason: "pipe closed", rule: "fail-closed" });
  });
});
