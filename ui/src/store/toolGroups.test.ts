import { describe, expect, it } from "vitest";
import { buildRows, emptyView, reduceEvents } from "./agent-reducer";
import type { AgentEvent } from "./agent-types";
import { groupRows, openByDefault, failingKeys, tallyOf, verbOf } from "./toolGroups";

let seq = 0;
const ev = (p: object, ts = ++seq * 1000) => ({ agentId: "a1", seq: ++seq, ts, provider: "claude", ...p }) as AgentEvent;
const run = (events: object[]) => {
  seq = 0;
  return reduceEvents(emptyView("a1"), events.map((p) => ev(p)));
};
const tool = (id: string, kind: string, name = "Tool", extra: object = {}) => [
  { kind: "tool.start", toolId: id, name, toolKind: kind, input: {}, ...extra },
  { kind: "tool.result", toolId: id, status: "ok", output: "ok" },
];
const say = (id: string, text: string) => [
  { kind: "text.delta", messageId: id, text },
  { kind: "text.done", messageId: id, text },
];
const display = (events: object[], waiting: string[] = []) => groupRows(buildRows(run(events).items), new Set(waiting));
const shape = (rows: ReturnType<typeof display>) => rows.map((r) => (r.group ? `group(${r.group.members.length})` : r.item.type));

describe("groupRows", () => {
  it("folds consecutive tool calls between two pieces of prose into one group", () => {
    const rows = display([{ kind: "user.message", messageId: "u", text: "go" }, ...tool("t1", "read"), ...tool("t2", "read"), ...tool("t3", "search"), ...say("m1", "Found it."), ...tool("t4", "exec"), ...say("m2", "Done.")]);
    expect(shape(rows)).toEqual(["user", "group(3)", "text", "group(1)", "text"]);
    expect(rows[1]!.group!.tally.verbs).toEqual([
      { verb: "read", n: 2 },
      { verb: "search", n: 1 },
    ]);
    expect(rows[1]!.group!.state).toBe("done");
  });

  it("keys a group by its first member, so the key holds while the group grows", () => {
    const a = display([...tool("t1", "read")]);
    const b = display([...tool("t1", "read"), ...tool("t2", "exec")]);
    expect(a[0]!.key).toBe("group:tool:t1");
    expect(b[0]!.key).toBe("group:tool:t1");
    expect(b[0]!.item.type === "tool" && b[0]!.item.toolId).toBe("t2");
  });

  it("is running while a call runs, and shows the newest step as the latest", () => {
    const rows = display([...tool("t1", "read"), { kind: "tool.start", toolId: "t2", name: "Bash", toolKind: "exec", input: { command: "pnpm test" } }]);
    const g = rows[0]!.group!;
    expect(g.state).toBe("running");
    expect(g.latest.key).toBe("tool:t2");
    expect(openByDefault(g)).toBe(false);
  });

  it("never folds a request that waits, and marks the group of its call as waiting", () => {
    const rows = display([...tool("t1", "read"), { kind: "tool.start", toolId: "t2", name: "Bash", toolKind: "exec", input: {} }, { kind: "permission.request", reqId: "p1", toolId: "t2", intent: { class: "exec", summary: "rm -rf build" }, options: ["allow_once", "deny"] }], ["t2"]);
    expect(shape(rows)).toEqual(["group(2)", "permission"]);
    expect(rows[0]!.group!.state).toBe("waiting");
    expect(openByDefault(rows[0]!.group!)).toBe(true);
  });

  it("folds a settled request into the activity, and a refused one makes the group failed and open", () => {
    const rows = display([
      { kind: "tool.start", toolId: "t1", name: "Bash", toolKind: "exec", input: {} },
      { kind: "permission.request", reqId: "p1", toolId: "t1", intent: { class: "exec", summary: "git commit" }, options: ["deny"] },
      { kind: "permission.resolved", reqId: "p1", outcome: "deny", by: "hardStop" },
      { kind: "tool.result", toolId: "t1", status: "denied", output: "Blocked by policy" },
      ...tool("t2", "read"),
    ]);
    expect(shape(rows)).toEqual(["group(3)"]);
    const g = rows[0]!.group!;
    expect(g.tally.blocked).toBe(1);
    expect(g.state).toBe("failed");
    expect(openByDefault(g)).toBe(true);
    expect(failingKeys(g)).toEqual(["tool:t1"]);
  });

  it("counts a refused request whose call never reported a result as blocked", () => {
    const rows = display([
      { kind: "tool.start", toolId: "t1", name: "Edit", toolKind: "edit", input: {} },
      { kind: "permission.request", reqId: "p1", toolId: "t1", intent: { class: "write", summary: ".env" }, options: ["allow_once", "deny"] },
      { kind: "permission.resolved", reqId: "p1", outcome: "deny", by: "user" },
      { kind: "turn.end", stopReason: "endTurn" },
    ]);
    const g = rows[0]!.group!;
    // the call was cancelled by the end of the turn; the refusal is what the person needs to see
    expect(g.tally.blocked).toBe(1);
    expect(g.state).toBe("failed");
  });

  it("marks an error and opens the failing call", () => {
    const rows = display([{ kind: "tool.start", toolId: "t1", name: "Bash", toolKind: "exec", input: {} }, { kind: "tool.result", toolId: "t1", status: "error", output: "exit 1" }]);
    expect(rows[0]!.group!.tally.failed).toBe(1);
    expect(failingKeys(rows[0]!.group!)).toEqual(["tool:t1"]);
  });

  it("keeps delegation, questions, plans, notes, errors and plan approvals out of groups", () => {
    const rows = display([
      ...tool("t1", "read"),
      { kind: "tool.start", toolId: "s1", name: "Task", toolKind: "other", input: { subagent_type: "explorer" } },
      { kind: "tool.start", toolId: "k1", name: "Grep", toolKind: "search", input: {}, parentToolId: "s1" },
      { kind: "tool.result", toolId: "k1", status: "ok" },
      { kind: "tool.result", toolId: "s1", status: "ok" },
      ...tool("t2", "read"),
      { kind: "plan", items: [{ content: "a", status: "pending" }] },
      ...tool("t3", "read"),
      { kind: "question.request", reqId: "q1", prompt: "Which?", options: [{ label: "A" }] },
      ...tool("t4", "read"),
      { kind: "permission.request", reqId: "x1", toolId: "t9", intent: { class: "other", tool: "ExitPlanMode", summary: "plan" }, options: ["allow_once", "deny"], plan: "1. do" },
      { kind: "permission.resolved", reqId: "x1", outcome: "allow", by: "user" },
      ...tool("t5", "read"),
      { kind: "error", class: "provider", message: "boom", retryable: true },
    ]);
    expect(shape(rows)).toEqual(["group(1)", "tool", "group(1)", "plan", "group(1)", "question", "group(1)", "permission", "group(1)", "error"]);
    // the subagent's own calls stay under its row
    expect(rows[1]!.children.map((c) => c.toolId)).toEqual(["k1"]);
  });

  it("leaves thinking alone when no call follows it, and folds it with the calls it precedes", () => {
    const rows = display([{ kind: "thinking.delta", messageId: "th1", text: "hmm" }, ...say("m1", "Hi."), { kind: "thinking.delta", messageId: "th2", text: "look" }, ...tool("t1", "read")]);
    expect(shape(rows)).toEqual(["thinking", "text", "group(2)"]);
  });

  it("measures thinking in whole seconds from when it closed", () => {
    seq = 0;
    const v = reduceEvents(emptyView("a1"), [ev({ kind: "thinking.delta", messageId: "th", text: "a" }, 10_000), ev({ kind: "tool.start", toolId: "t1", name: "Read", toolKind: "read", input: {} }, 14_400), ev({ kind: "tool.result", toolId: "t1", status: "ok" }, 14_500)]);
    const rows = groupRows(buildRows(v.items));
    expect(rows[0]!.group!.tally.thoughtSec).toBe(4);
  });

  it("a run that ends mid-group: the open call is cancelled and the group is done, not running", () => {
    const rows = display([...tool("t1", "read"), { kind: "tool.start", toolId: "t2", name: "Bash", toolKind: "exec", input: {} }, { kind: "turn.end", stopReason: "cancelled" }]);
    expect(rows[0]!.group!.state).toBe("done");
    expect(shape(rows)).toEqual(["group(2)", "turn"]);
  });

  it("is linear: 600 calls make one group quickly", () => {
    const events: object[] = [];
    for (let i = 0; i < 600; i++) events.push(...tool(`t${i}`, i % 3 === 0 ? "read" : i % 3 === 1 ? "search" : "exec"));
    const items = run(events).items;
    const started = performance.now();
    const rows = groupRows(buildRows(items));
    expect(performance.now() - started).toBeLessThan(100);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.group!.tally.calls).toBe(600);
  });
});

describe("tallyOf / verbOf", () => {
  it("counts moves and deletes as changes, think and other tools as other", () => {
    expect(["edit", "move", "delete", "think", "other", "mcp", "fetch"].map((k) => verbOf(k as never))).toEqual(["edit", "edit", "edit", "other", "other", "mcp", "fetch"]);
    expect(tallyOf([])).toEqual({ verbs: [], calls: 0, failed: 0, blocked: 0, thoughtSec: 0 });
  });
});
