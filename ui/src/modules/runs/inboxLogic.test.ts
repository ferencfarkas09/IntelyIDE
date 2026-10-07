import { describe, expect, it } from "vitest";
import { collectInbox, describeEntry } from "./inboxLogic";
import { PERMISSION, row, viewOf } from "./testing";

describe("collectInbox", () => {
  const views = {
    a: viewOf("a", [PERMISSION], 2_000),
    b: viewOf("b", [{ kind: "question.request", reqId: "q1", prompt: "Which currency?", options: [{ label: "HUF" }, { label: "EUR" }] }, { ...PERMISSION, reqId: "r2" }], 1_000),
    c: viewOf("c", [{ ...PERMISSION, reqId: "r3" }, { kind: "permission.resolved", reqId: "r3", outcome: "allow", by: "user" }]),
  };
  const rows = [row({ agentId: "a", role: "developer" }), row({ agentId: "b", role: "architect" }), row({ agentId: "c" }), row({ agentId: "d" })];
  const inbox = collectInbox(rows, (id) => views[id as keyof typeof views]);

  it("lists open requests of every run, oldest first, and skips answered or unloaded runs", () => {
    expect(inbox.map((e) => e.key)).toEqual(["b:q1", "b:r2", "a:r1"]);
  });

  it("describes an entry for a notification", () => {
    expect(describeEntry(inbox[0])).toEqual({ title: "architect needs you", body: "Which currency?" });
    expect(describeEntry(inbox[2])).toEqual({ title: "developer needs you", body: "Run npm test" });
  });
});
