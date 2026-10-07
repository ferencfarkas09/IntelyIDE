import { describe, expect, it } from "vitest";
import { apply, emptyTranscript, fold, markQuestionAnswered, toolLabel } from "./transcript";
import type { AgentEvent } from "./wire";

let n = 0;
const ev = (kind: Record<string, unknown>, seq = ++n): AgentEvent => ({ agentId: "a", seq, ts: seq * 1000, provider: "claude", ...kind }) as AgentEvent;

describe("transcript", () => {
  it("streams assistant text by message id and closes it on done", () => {
    n = 0;
    const t = fold([ev({ kind: "text.delta", messageId: "m", text: "Hel" }), ev({ kind: "text.delta", messageId: "m", text: "lo" })]);
    expect(t.rows).toMatchObject([{ kind: "assistant", text: "Hello", streaming: true }]);
    apply(t, ev({ kind: "text.done", messageId: "m", text: "Hello there" }));
    expect(t.rows).toMatchObject([{ text: "Hello there", streaming: false }]);
  });

  it("collapses a tool call to one line with its status and output", () => {
    n = 0;
    const t = fold([ev({ kind: "tool.start", toolId: "x", name: "Bash", toolKind: "exec", input: { command: "npm test" } }), ev({ kind: "tool.result", toolId: "x", status: "error", output: "1 failed", durationMs: 4 })]);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0]).toMatchObject({ kind: "tool", label: "Ran npm test (failed)", status: "error", output: "1 failed" });
  });

  it("ignores a replayed or older event (seq resume is idempotent)", () => {
    n = 0;
    const events = [ev({ kind: "user.message", messageId: "u", text: "hi" }), ev({ kind: "text.done", messageId: "m", text: "yo" })];
    const t = fold(events);
    fold(events, t);
    expect(t.rows).toHaveLength(2);
    expect(t.lastSeq).toBe(2);
  });

  it("keeps subagent chatter out of the calm view and tracks permission and question rows", () => {
    n = 0;
    const t = fold([
      ev({ kind: "text.done", messageId: "s", text: "inner", parentToolId: "t0" }),
      ev({ kind: "permission.request", reqId: "r1", toolId: "t1", intent: { class: "exec", summary: "Run ls" } }),
      ev({ kind: "question.request", reqId: "q1", prompt: "Which?" }),
    ]);
    expect(t.rows.map((r) => r.kind)).toEqual(["permission", "question"]);
    apply(t, ev({ kind: "permission.resolved", reqId: "r1", outcome: "deny", by: "user" }));
    expect(t.rows[0]).toMatchObject({ state: "deny" });
    markQuestionAnswered(t, "q1");
    expect(t.rows[1]).toMatchObject({ state: "answered" });
  });

  it("labels the common tool kinds in words", () => {
    expect(toolLabel("Edit", "edit", { file_path: "src/a.ts" }, "ok")).toBe("Edited src/a.ts");
    expect(toolLabel("Read", "read", { path: "README.md" }, "ok")).toBe("Read README.md");
    expect(toolLabel("Grep", "search", { pattern: "TODO" }, "ok")).toBe("Searched TODO");
    expect(toolLabel("Bash", "exec", { command: "rm -rf x" }, "denied")).toBe("Ran rm -rf x (denied)");
    expect(toolLabel("mcp__x__y", "mcp", {}, "ok")).toBe("mcp__x__y");
  });
});
