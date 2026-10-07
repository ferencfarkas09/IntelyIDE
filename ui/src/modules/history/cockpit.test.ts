import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../store/agent-types";
import { buildCockpit, contextWindow } from "./cockpit";

let seq = 0;
const ev = (kind: Record<string, unknown>): AgentEvent => ({ agentId: "r1", seq: ++seq, ts: 1_000 + seq, provider: "claude", ...kind }) as unknown as AgentEvent;
const tool = (id: string, name: string, toolKind: string, input: unknown, output = "", status = "ok", diff?: unknown) => [
  ev({ kind: "tool.start", toolId: id, name, toolKind, input }),
  ev({ kind: "tool.result", toolId: id, status, output, ...(diff ? { diff } : {}) }),
];
const counts = (input: number, output: number, costUsd?: number) => ({ inputTokens: input, outputTokens: output, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, ...(costUsd === undefined ? {} : { costUsd }) });
const usage = (perTurn: ReturnType<typeof counts>, cumulative: ReturnType<typeof counts>, extra: Record<string, unknown> = {}) =>
  ev({ kind: "usage", usage: { model: "claude-sonnet-5-5", costBasis: "estimated", perTurn, cumulative, ...extra } });

describe("contextWindow", () => {
  it("knows the Claude windows and says nothing about other models", () => {
    expect(contextWindow("claude-sonnet-5-5")).toBe(200_000);
    expect(contextWindow("claude-opus-5-5[1m]")).toBe(1_000_000);
    expect(contextWindow("gpt-9")).toBeUndefined();
    expect(contextWindow(undefined)).toBeUndefined();
  });
});

describe("buildCockpit", () => {
  it("counts reads and edits per file and breaks tool calls down", () => {
    const c = buildCockpit([
      ev({ kind: "user.message", messageId: "u1", text: "go", attachments: [{ id: "a", name: "spec.pdf", mime: "application/pdf", size: 2048, kind: "pdf", sha256: "x" }] }),
      ...tool("t1", "Read", "read", { file_path: "src/a.js" }, "x".repeat(100)),
      ...tool("t2", "Read", "read", { file_path: "src/a.js" }, "x".repeat(100)),
      ...tool("t3", "Edit", "edit", { file_path: "src/a.js" }, "", "ok", { path: "src/a.js", old: "a", new: "b" }),
      ...tool("t4", "Bash", "exec", { command: "npm test" }, "boom", "error"),
    ]);
    expect(c.files).toEqual([{ path: "src/a.js", reads: 2, edits: 1, readChars: 200 }]);
    expect(c.tools.map((t) => [t.name, t.calls, t.errors])).toEqual([["Read", 2, 0], ["Bash", 1, 1], ["Edit", 1, 0]]);
    expect(c.toolCalls).toBe(4);
    expect(c.attachments.map((a) => a.name)).toEqual(["spec.pdf"]);
  });

  it("never invents usage: no usage event means no totals, no turn, no per-tool numbers", () => {
    const c = buildCockpit([ev({ kind: "user.message", messageId: "u1", text: "hello there" }), ...tool("t1", "Read", "read", { path: "a" }, "abc")]);
    expect(c.totals).toBeUndefined();
    expect(c.turns).toEqual([]);
    expect(c.tools[0].estTokens).toBeUndefined();
    expect(c.tools[0].estCostUsd).toBeUndefined();
    expect(c.warnings.map((w) => w.kind)).toEqual(["noUsage"]);
    expect(c.context.source).toBe("estimated");
  });

  it("shares each turn's tokens and cost between its tools by size, and leaves cost out when the turn has none", () => {
    const c = buildCockpit([
      ...tool("t1", "Read", "read", { path: "a" }, "x".repeat(300)),
      ...tool("t2", "Bash", "exec", { command: "ls" }, "y".repeat(100)),
      usage(counts(1000, 200, 0.4), counts(1000, 200, 0.4)),
      ...tool("t3", "Read", "read", { path: "b" }, "z".repeat(100)),
      usage(counts(500, 100), counts(1500, 300, 0.4)),
    ]);
    expect(c.turns.map((t) => [t.index, t.tools, t.costUsd])).toEqual([[1, 2, 0.4], [2, 1, undefined]]);
    const read = c.tools.find((t) => t.name === "Read")!;
    const bash = c.tools.find((t) => t.name === "Bash")!;
    expect(read.estCostUsd!).toBeGreaterThan(bash.estCostUsd!);
    expect(read.estCostUsd! + bash.estCostUsd!).toBeCloseTo(0.4, 6);
    expect(read.estTokens! + bash.estTokens!).toBeCloseTo(1200 + 600, 6);
    expect(c.totals).toMatchObject({ inputTokens: 1500, outputTokens: 300, costUsd: 0.4, basis: "estimated" });
  });

  it("takes the window fill from the provider when it reports it, and warns at 80 and 95 percent", () => {
    const at = (used: number) => buildCockpit([usage(counts(1, 1), counts(1, 1), { contextUsed: used, contextSize: 200_000 })]);
    expect(at(100_000).context).toMatchObject({ used: 100_000, size: 200_000, fraction: 0.5, source: "reported" });
    expect(at(100_000).warnings).toEqual([]);
    expect(at(160_000).warnings).toEqual([{ kind: "contextHigh", params: { percent: 80 } }]);
    expect(at(190_000).warnings).toEqual([{ kind: "contextCritical", params: { percent: 95 } }]);
  });

  it("estimates from the text when nothing was reported, with the window from the model name only", () => {
    const text = "x".repeat(40_000);
    const c = buildCockpit([ev({ kind: "user.message", messageId: "u1", text })], "claude-sonnet-5-5");
    expect(c.context).toMatchObject({ used: 10_000, size: 200_000, source: "estimated" });
    const unknown = buildCockpit([ev({ kind: "user.message", messageId: "u1", text })], "mystery-model");
    expect(unknown.context.size).toBeUndefined();
    expect(unknown.context.fraction).toBeUndefined();
    expect(buildCockpit([]).context.source).toBe("unknown");
  });

  it("warns about a large file read again and again, but not about small ones or a single big read", () => {
    const big = "x".repeat(5000);
    const c = buildCockpit([
      ...tool("1", "Read", "read", { file_path: "big.js" }, big),
      ...tool("2", "Read", "read", { file_path: "big.js" }, big),
      ...tool("3", "Read", "read", { file_path: "big.js" }, big),
      ...tool("4", "Read", "read", { file_path: "small.js" }, "x"),
      ...tool("5", "Read", "read", { file_path: "small.js" }, "x"),
      ...tool("6", "Read", "read", { file_path: "small.js" }, "x"),
      ...tool("7", "Read", "read", { file_path: "once.js" }, big),
      usage(counts(1, 1), counts(1, 1)),
    ]);
    expect(c.warnings).toEqual([{ kind: "repeatedReads", params: { path: "big.js", count: 3 } }]);
  });
});
