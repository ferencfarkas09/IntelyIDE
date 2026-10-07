import { describe, expect, it } from "vitest";
import { buildRows, emptyView, isExitPlan, markPermissionAnswered, markPermissionRefused, markQuestionAnswered, pendingPermissions, reduceEvents, runStatus, type AgentView, type PermissionItem, type NoteItem, type TextItem, type ToolItem } from "./agent-reducer";
import type { AgentEvent } from "./agent-types";

/** Tests write payloads in short form; the reducer sees them like the wire ones. */
type EventPayload = { kind: string; [key: string]: unknown };

let seq = 0;
const ev = (p: EventPayload, s = ++seq): AgentEvent => ({ agentId: "a1", seq: s, ts: 1_000 + s, provider: "claude", ...p }) as AgentEvent;
const run = (events: EventPayload[], from: AgentView = emptyView("a1")): AgentView => {
  seq = from.lastSeq;
  return reduceEvents(from, events.map((p) => ev(p)));
};
const items = <T>(v: AgentView, type: string) => v.items.filter((i) => i.type === type) as T[];

describe("seq invariant", () => {
  it("ignores duplicates and out-of-order events and counts them", () => {
    let v = reduceEvents(emptyView("a1"), [ev({ kind: "text.delta", messageId: "m", text: "a" }, 1), ev({ kind: "text.delta", messageId: "m", text: "b" }, 2)]);
    v = reduceEvents(v, [ev({ kind: "text.delta", messageId: "m", text: "b" }, 2), ev({ kind: "text.delta", messageId: "m", text: "x" }, 1)]);
    expect(items<TextItem>(v, "text")[0].text).toBe("ab");
    expect(v.lastSeq).toBe(2);
    expect(v.duplicates).toBe(2);
  });

  it("flags a gap but keeps applying", () => {
    const v = reduceEvents(emptyView("a1"), [ev({ kind: "text.delta", messageId: "m", text: "a" }, 1), ev({ kind: "text.delta", messageId: "m", text: "c" }, 4)]);
    expect(v.gaps).toEqual([{ from: 2, to: 3 }]);
    expect(items<TextItem>(v, "text")[0].text).toBe("ac");
  });

  it("does not mutate the previous view and returns the same object for an empty batch", () => {
    const base = run([{ kind: "text.delta", messageId: "m", text: "a" }]);
    const frozen = JSON.stringify(base);
    const next = run([{ kind: "text.delta", messageId: "m", text: "b" }], base);
    expect(JSON.stringify(base)).toBe(frozen);
    expect(next).not.toBe(base);
    expect(reduceEvents(base, [])).toBe(base);
  });
});

describe("delta assembly", () => {
  it("joins text deltas per message and closes them on text.done", () => {
    const v = run([
      { kind: "text.delta", messageId: "m1", text: "Hel" },
      { kind: "text.delta", messageId: "m2", text: "other" },
      { kind: "text.delta", messageId: "m1", text: "lo" },
      { kind: "text.done", messageId: "m1", text: "Hello" },
    ]);
    const [a, b] = items<TextItem>(v, "text");
    expect([a.text, a.done, b.text, b.done]).toEqual(["Hello", true, "other", false]);
  });

  it("keeps thinking open while it streams and closes it when something else arrives", () => {
    let v = run([{ kind: "thinking.delta", messageId: "t", text: "hmm " }, { kind: "thinking.delta", messageId: "t", text: "ok" }]);
    expect(items<{ done: boolean; text: string }>(v, "thinking")[0]).toMatchObject({ text: "hmm ok", done: false });
    v = run([{ kind: "text.delta", messageId: "m", text: "x" }], v);
    expect(items<{ done: boolean }>(v, "thinking")[0].done).toBe(true);
  });

  it("replaces the plan in place and takes the latest cumulative usage", () => {
    const counts = (n: number) => ({ inputTokens: n, outputTokens: 1, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 });
    const usage = (n: number) => ({ kind: "usage" as const, usage: { costBasis: "subscription" as const, model: "m", perTurn: counts(1), cumulative: counts(n) } });
    const v = run([
      { kind: "plan", items: [{ content: "a", status: "pending" }] },
      { kind: "plan", items: [{ content: "a", status: "completed" }] },
      usage(10),
      usage(20),
    ]);
    expect(items(v, "plan")).toHaveLength(1);
    expect((items(v, "plan")[0] as { items: { status: string }[] }).items[0].status).toBe("done");
    expect(v.usage?.cumulative.inputTokens).toBe(20);
  });
});

describe("tool lifecycle", () => {
  it("goes running -> ok with output, diff and duration", () => {
    const v = run([
      { kind: "tool.start", toolId: "t", name: "Edit", toolKind: "edit", summary: "a.ts" },
      { kind: "tool.update", toolId: "t", status: "running", output: "partial" },
      { kind: "tool.result", toolId: "t", status: "ok", diff: { path: "a.ts", old: "1", new: "2" }, durationMs: 12 },
    ]);
    expect(items<ToolItem>(v, "tool")[0]).toMatchObject({ status: "ok", output: "partial", durationMs: 12, diff: { path: "a.ts" } });
  });

  it("nests subagent tool calls under their parent", () => {
    const v = run([
      { kind: "tool.start", toolId: "s", name: "Task", toolKind: "other" },
      { kind: "tool.start", toolId: "c1", name: "Grep", toolKind: "search", parentToolId: "s" },
      { kind: "tool.start", toolId: "x", name: "Read", toolKind: "read", parentToolId: "unknown-parent" },
    ]);
    const rows = buildRows(v.items);
    expect(rows.map((r) => r.key)).toEqual(["tool:s", "tool:x"]);
    expect(rows[0].children.map((c) => c.toolId)).toEqual(["c1"]);
  });

  it("ignores results for tools it never saw", () => {
    const v = run([{ kind: "tool.result", toolId: "ghost", status: "ok" }]);
    expect(v.items).toHaveLength(0);
  });
});

describe("cancel", () => {
  it("closes everything that is still open when the turn ends cancelled", () => {
    const v = run([
      { kind: "user.message", messageId: "u1", text: "go" },
      { kind: "text.delta", messageId: "m", text: "partial" },
      { kind: "tool.start", toolId: "t", name: "Bash", toolKind: "exec" },
      { kind: "permission.request", reqId: "p", toolId: "t", intent: { class: "exec", summary: "x" }, options: ["allow_once", "deny"] },
      { kind: "question.request", reqId: "q", prompt: "?", options: [] },
      { kind: "status", state: "waitingUser" },
      { kind: "turn.end", stopReason: "cancelled" },
    ]);
    expect(items<TextItem>(v, "text")[0].done).toBe(true);
    expect(items<ToolItem>(v, "tool")[0].status).toBe("cancelled");
    expect(items<PermissionItem>(v, "permission")[0]).toMatchObject({ outcome: "cancelled" });
    expect(items<{ cancelled?: boolean }>(v, "question")[0].cancelled).toBe(true);
    expect(items<{ stopReason: string }>(v, "turn")[0].stopReason).toBe("cancelled");
    expect(v.turnActive).toBe(false);
    expect(v.state).toBe("idle");
    expect(runStatus(v)).toBe("done");
  });

  it("adds no marker for a normal end and reports error runs", () => {
    expect(items(run([{ kind: "turn.end", stopReason: "endTurn" }]), "turn")).toHaveLength(0);
    expect(runStatus(run([{ kind: "user.message", messageId: "u", text: "x" }, { kind: "turn.end", stopReason: "error" }]))).toBe("error");
  });
});

describe("status", () => {
  it("is needsYou while something waits, running during a turn", () => {
    let v = run([{ kind: "user.message", messageId: "u", text: "x" }]);
    expect(runStatus(v)).toBe("running");
    v = run([{ kind: "permission.request", reqId: "p", toolId: "t", intent: { class: "write", summary: "w" }, options: ["allow_once"] }], v);
    expect(runStatus(v)).toBe("needsYou");
    expect(pendingPermissions(v)).toHaveLength(1);
    v = run([{ kind: "permission.resolved", reqId: "p", outcome: "allow", by: "user" }], v);
    expect(runStatus(v)).toBe("running");
  });

  it("tracks throttling with its start time and clears it on the next status", () => {
    let v = run([{ kind: "status", state: "throttled", retryAfterMs: 60_000, scope: "5h window" }]);
    expect(v.throttle).toMatchObject({ state: "throttled", retryAfterMs: 60_000, scope: "5h window" });
    expect(run([{ kind: "status", state: "retrying" }]).throttle).toMatchObject({ state: "retrying" });
    v = run([{ kind: "status", state: "running" }], v);
    expect(v.throttle).toBeUndefined();
  });
});

describe("local answers", () => {
  it("marks a permission answered once, and a question with its answer", () => {
    let v = run([
      { kind: "permission.request", reqId: "p", toolId: "t", intent: { class: "exec", summary: "x" }, options: ["allow_once", "deny"] },
      { kind: "question.request", reqId: "q", prompt: "?", options: [{ label: "A" }] },
    ]);
    v = markPermissionAnswered(v, "p", "allowOnce");
    expect(items<PermissionItem>(v, "permission")[0]).toMatchObject({ decision: "allowOnce", outcome: "allow", by: "user" });
    expect(markPermissionAnswered(v, "p", "deny")).toBe(v);
    v = markQuestionAnswered(v, "q", { optionIds: ["a"] });
    expect(items<{ answer?: unknown }>(v, "question")[0].answer).toEqual({ optionIds: ["a"] });
  });
});

describe("delegates", () => {
  const d = (name: string) => ({ name, description: "x", model: "claude-sonnet-5-5", permission: "edit", scope: "global" });

  it("folds the delegate table of session.info and keeps the latest one (a resumed run rebuilds it)", () => {
    let v = run([{ kind: "session.info", title: "t", delegates: [d("developer")] }]);
    expect(v.delegates?.map((x) => x.name)).toEqual(["developer"]);
    v = run([{ kind: "session.info", delegates: [d("developer"), d("reviewer")] }], v);
    expect(v.delegates?.map((x) => x.name)).toEqual(["developer", "reviewer"]);
  });

  it("folds the CLI's slash commands and the MCP servers of session.info, the latest list winning, and leaves them alone when absent", () => {
    let v = run([{ kind: "session.info", slashCommands: ["compact", "cost"], mcpServers: [{ name: "github", status: "connected", tools: 3 }] }]);
    expect(v.slashCommands).toEqual(["compact", "cost"]);
    expect(v.mcpServers).toEqual([{ name: "github", status: "connected", tools: 3 }]);
    v = run([{ kind: "session.info", title: "t" }], v);
    expect(v.slashCommands).toEqual(["compact", "cost"]);
    v = run([{ kind: "session.info", mcpServers: [{ name: "github", status: "failed", error: "boom" }] }], v);
    expect(v.mcpServers).toEqual([{ name: "github", status: "failed", error: "boom" }]);
  });

  it("a session.info without delegates leaves the table alone, and a single-role run never gets one", () => {
    let v = run([{ kind: "session.info", delegates: [d("developer")] }]);
    v = run([{ kind: "session.info", title: "renamed" }], v);
    expect(v.delegates).toHaveLength(1);
    expect(run([{ kind: "session.info", title: "t" }]).delegates).toBeUndefined();
  });
});

const started = (permission: string) => ({ kind: "session.started", nativeId: "n1", model: "claude-sonnet-5-5", effective: { permission } });
const exec = (command: string) => ({ class: "exec", rawCommand: command, summary: command });
const request = (reqId: string, extra: Record<string, unknown> = {}, intent: Record<string, unknown> = exec("rm -rf build")) => ({ kind: "permission.request", reqId, toolId: `t-${reqId}`, intent, options: ["allow_once", "deny"], ...extra });
const perms = (v: AgentView) => items<PermissionItem>(v, "permission");

describe("permission requests", () => {
  it("maps the three wire options to the card's words, and keeps the session allow offer", () => {
    const v = run([
      started("ask"),
      request("p1", { options: ["allow_once", "allow_run", "deny"], sessionAllow: { kind: "exec", scope: "git status" } }),
      request("p2", { options: ["allow_once", "deny"] }),
      request("p3", { options: undefined }),
    ]);
    const [a, b, c] = perms(v);
    expect(a.options).toEqual(["allowOnce", "allowRun", "deny"]);
    expect(a.sessionAllow).toEqual({ kind: "exec", scope: "git status" });
    expect(b.options).toEqual(["allowOnce", "deny"]);
    expect(b.sessionAllow).toBeUndefined();
    expect(c.options).toEqual(["allowOnce", "deny"]);
  });

  it("keeps the plan text, whether it was cut, and the modes the card offers", () => {
    const intent = { class: "other", tool: "ExitPlanMode", summary: "ExitPlanMode: leave plan mode" };
    const v = run([started("readOnly"), request("p1", { plan: "## Plan\n1. do it", planTruncated: true, modes: ["ask", "edit", "automatic"] }, intent)]);
    const [p] = perms(v);
    expect(p).toMatchObject({ plan: "## Plan\n1. do it", planTruncated: true, modes: ["ask", "edit", "automatic"] });
    expect(isExitPlan(p.intent)).toBe(true);
    // A delegate's ExitPlanMode is no approval card.
    expect(isExitPlan({ ...intent, actor: { agentId: "s1", role: "developer" } } as PermissionItem["intent"])).toBe(false);
  });

  it("remembers the mode the run had before it went into Plan, for the approval card's default", () => {
    const intent = { class: "other", tool: "ExitPlanMode", summary: "ExitPlanMode: leave plan mode" };
    const v = run([started("edit"), { kind: "session.info", effective: { permission: "readOnly", reason: "user" } }, request("p1", {}, intent)]);
    expect(v.prePlanMode).toBe("edit");
    expect(perms(v)[0].prePlanMode).toBe("edit");
    // A run that started in Plan has no earlier mode.
    expect(perms(run([started("readOnly"), request("p1", {}, intent)]))[0].prePlanMode).toBeUndefined();
  });

  it("records the answer's mode and note on the card, and clears an earlier refusal", () => {
    const v = run([started("readOnly"), request("p1", {}, { class: "other", tool: "ExitPlanMode", summary: "x" })]);
    const refused = markPermissionRefused(v, "p1", "writeLease");
    expect(perms(refused)[0].error).toEqual({ code: "writeLease", message: undefined });
    const approved = markPermissionAnswered(refused, "p1", "allowOnce", { mode: "edit" });
    expect(perms(approved)[0]).toMatchObject({ outcome: "allow", decision: "allowOnce", by: "user", mode: "edit" });
    expect(perms(approved)[0].error).toBeUndefined();
    const rejected = markPermissionAnswered(v, "p1", "deny", { feedback: "smaller steps" });
    expect(perms(rejected)[0]).toMatchObject({ outcome: "deny", feedback: "smaller steps" });
  });

  it("puts a refused answer back to pending with the reason, so it can be answered again", () => {
    const v = run([started("ask"), request("p1")]);
    const answered = markPermissionAnswered(v, "p1", "allowOnce");
    expect(pendingPermissions(answered)).toHaveLength(0);
    const back = markPermissionRefused(answered, "p1", "optionNotOffered", "no");
    expect(pendingPermissions(back)).toHaveLength(1);
    expect(perms(back)[0]).toMatchObject({ error: { code: "optionNotOffered", message: "no" } });
    expect(perms(back)[0].decision).toBeUndefined();
    expect(perms(back)[0].outcome).toBeUndefined();
  });

  it("resolves a card as withdrawn when the host refused a late click with modeChanged", () => {
    const v = run([started("ask"), request("p1")]);
    const late = markPermissionRefused(markPermissionAnswered(v, "p1", "allowOnce"), "p1", "modeChanged");
    expect(perms(late)[0]).toMatchObject({ outcome: "deny", withdrawn: true });
    expect(pendingPermissions(late)).toHaveLength(0);
  });

  it("resolves a card as withdrawn when a denial nobody here asked for follows a change of the run's mode", () => {
    const v = run([started("ask"), request("p1"), { kind: "session.info", effective: { permission: "readOnly", reason: "user" } }, { kind: "permission.resolved", reqId: "p1", outcome: "deny", by: "user" }]);
    expect(perms(v)[0]).toMatchObject({ outcome: "deny", by: "user", withdrawn: true });
  });

  it("does not call a denial withdrawn when you denied it, or when the mode did not change", () => {
    const base = run([started("ask"), request("p1"), request("p2")]);
    const yours = run([{ kind: "session.info", effective: { permission: "readOnly" } }, { kind: "permission.resolved", reqId: "p1", outcome: "deny", by: "user" }], markPermissionAnswered(base, "p1", "deny"));
    expect(perms(yours)[0].withdrawn).toBeUndefined();
    const same = run([{ kind: "permission.resolved", reqId: "p2", outcome: "deny", by: "user" }], base);
    expect(perms(same)[1].withdrawn).toBeUndefined();
  });
});

describe("mode changes", () => {
  it("folds session.info.effective into the live session, and keeps the rest of the session", () => {
    const v = run([started("ask"), { kind: "session.info", effective: { permission: "automatic", reason: "user" } }]);
    expect(v.session).toMatchObject({ nativeId: "n1", model: "claude-sonnet-5-5", effective: { permission: "automatic" } });
    expect(v.banner).toBeUndefined();
  });

  it("creates the session when session.info comes first", () => {
    const v = run([{ kind: "session.info", nativeId: "n2", effective: { permission: "edit" } }]);
    expect(v.session).toMatchObject({ nativeId: "n2", model: "", effective: { permission: "edit" } });
  });

  it("ignores a session.info without a mode", () => {
    const v = run([started("ask"), { kind: "session.info", title: "x" }]);
    expect(v.session?.effective.permission).toBe("ask");
  });

  it("leaves a banner when the host changed the mode on its own: a resume dropped Bypass, a role changed, the build limits the modes", () => {
    const down = run([started("bypass"), { kind: "session.info", effective: { permission: "automatic", reason: "resumeDowngrade" } }]);
    expect(down.banner).toEqual({ kind: "resumeDowngrade", seq: down.lastSeq });
    expect(run([{ kind: "session.info", effective: { permission: "ask", reason: "roleChanged" } }], down).banner?.kind).toBe("roleChanged");
    expect(run([{ kind: "session.info", effective: { permission: "ask", reason: "provider" } }]).banner?.kind).toBe("providerLimit");
    // A change the user made or an approved plan is no news.
    expect(run([{ kind: "session.info", effective: { permission: "ask", reason: "planApproved" } }]).banner).toBeUndefined();
  });

  it("names the mode an approved plan continued in on the plan card", () => {
    const intent = { class: "other", tool: "ExitPlanMode", summary: "x" };
    const v = run([started("readOnly"), request("p1", {}, intent), { kind: "permission.resolved", reqId: "p1", outcome: "allow", by: "user" }, { kind: "session.info", effective: { permission: "edit", reason: "planApproved" } }]);
    expect(perms(v)[0].mode).toBe("edit");
    expect(v.session?.effective.permission).toBe("edit");
  });
});

describe("notes", () => {
  const note = (p: Record<string, unknown>): EventPayload => ({ kind: "note", noteId: "n1", ...p });

  it("opens a note as queued with its text and updates the same item when it is delivered", () => {
    let v = run([{ kind: "user.message", messageId: "u1", text: "go" }, note({ state: "queued", text: "use staging" })]);
    expect(items<NoteItem>(v, "note")).toMatchObject([{ noteId: "n1", state: "queued", text: "use staging" }]);
    v = run([note({ state: "delivered", toolId: "t4" })], v);
    const [n] = items<NoteItem>(v, "note");
    expect(items<NoteItem>(v, "note")).toHaveLength(1);
    expect(n).toMatchObject({ state: "delivered", text: "use staging", toolId: "t4" });
  });

  it("keeps why a note was dropped, and builds the item from a dropped event alone (a log that starts later)", () => {
    const v = run([note({ state: "queued", text: "x", parentToolId: "ag1" }), note({ state: "dropped", reason: "finished", parentToolId: "ag1" }), note({ noteId: "n2", state: "dropped", reason: "turnEnded" })]);
    expect(items<NoteItem>(v, "note")).toMatchObject([
      { noteId: "n1", state: "dropped", reason: "finished", parentToolId: "ag1", text: "x" },
      { noteId: "n2", state: "dropped", reason: "turnEnded", text: "" },
    ]);
  });

  it("puts a subagent's notes under its tool row and a note for the lead in the stream", () => {
    const v = run([
      { kind: "tool.start", toolId: "ag1", name: "Agent", toolKind: "other", input: {} },
      { kind: "tool.start", toolId: "t2", name: "Read", toolKind: "read", input: {}, parentToolId: "ag1" },
      note({ state: "queued", text: "for the subagent", parentToolId: "ag1" }),
      note({ noteId: "n2", state: "queued", text: "for the lead" }),
    ]);
    const rows = buildRows(v.items);
    expect(rows.map((r) => r.item.type)).toEqual(["tool", "note"]);
    expect(rows[0].children.map((c) => c.toolId)).toEqual(["t2"]);
    expect(rows[0].notes.map((n) => n.text)).toEqual(["for the subagent"]);
    expect((rows[1].item as NoteItem).text).toBe("for the lead");
    expect(rows[1].notes).toEqual([]);
  });

  it("shows a note whose subagent row is unknown as a row of its own", () => {
    const rows = buildRows(run([note({ state: "queued", text: "orphan", parentToolId: "gone" })]).items);
    expect(rows.map((r) => r.item.type)).toEqual(["note"]);
  });

  it("a note still queued when the turn ends was never reported: it reads as not delivered", () => {
    const v = run([{ kind: "user.message", messageId: "u1", text: "go" }, note({ state: "queued", text: "x" }), { kind: "turn.end", stopReason: "endTurn" }]);
    expect(items<NoteItem>(v, "note")[0]).toMatchObject({ state: "dropped", reason: "turnEnded" });
  });
});
