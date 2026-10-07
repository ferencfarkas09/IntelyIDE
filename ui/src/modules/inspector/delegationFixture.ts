import type { AgentEvent, EventPayload } from "../../store/agent-types";

/** A finished Auto run: a lead and three delegates ((design notes: roles-orchestration-spec) 4.4), one refused call, one call that ran on another model than its role says. Test data only. */
const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";
const T0 = Date.UTC(2026, 9, 5, 9, 0, 0);

export function delegationEvents(agentId = "run-auto"): AgentEvent[] {
  let seq = 0;
  const e = (dt: number, p: EventPayload, raw?: Record<string, unknown>): AgentEvent => ({ agentId, seq: ++seq, ts: T0 + dt, turnId: "turn-1", provider: "claude", ...(raw ? { raw } : {}), ...p }) as AgentEvent;
  const msg = (model: string) => ({ message: { model } });
  const counts = (i: number, o: number, usd: number) => ({ inputTokens: i, outputTokens: o, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, costUsd: usd });
  return [
    e(0, { kind: "session.started", nativeId: "native-auto", model: SONNET, effective: { effort: "medium", permission: "edit" }, assertions: [] }),
    e(10, {
      kind: "session.info",
      title: "Format totals",
      delegates: [
        { name: "researcher", description: "Read-only lookup", model: HAIKU, permission: "readOnly", tools: ["Read", "Grep", "Glob"], scope: "builtin", color: "#f0a23a" },
        { name: "developer", description: "Implements code", model: SONNET, effort: "medium", permission: "edit", tools: ["Read", "Edit", "Write", "Bash"], scope: "global", color: "#4caf7d" },
        { name: "reviewer", description: "Reads a change", model: SONNET, effort: "high", permission: "edit", tools: ["Read", "Bash"], scope: "repo", color: "#3b9ae8" },
      ],
    } as EventPayload),
    e(20, { kind: "user.message", messageId: "u1", text: "Format totals with the currency" }),
    e(100, { kind: "tool.start", toolId: "d1", name: "Agent", toolKind: "other", input: { subagent_type: "researcher", description: "find where totals are formatted" } }),
    e(150, { kind: "tool.start", toolId: "t1", name: "Grep", toolKind: "search", input: { pattern: "toFixed" }, parentToolId: "d1" }, msg(HAIKU)),
    e(300, { kind: "tool.result", toolId: "t1", status: "ok", output: "src/utils/format.ts:2", durationMs: 150 }),
    e(320, { kind: "tool.start", toolId: "t2", name: "Edit", toolKind: "edit", input: { file_path: "src/utils/format.ts" }, parentToolId: "d1" }, msg(HAIKU)),
    e(330, { kind: "permission.request", reqId: "r1", toolId: "t2", intent: { class: "write", tool: "Edit", paths: ["src/utils/format.ts"], parentToolId: "d1", summary: "Edit src/utils/format.ts", actor: { agentId: "sub-d1", role: "researcher" } }, options: ["deny"] }),
    e(340, { kind: "permission.resolved", reqId: "r1", outcome: "deny", by: "roleDeny", rule: "role.read-only" } as EventPayload),
    e(350, { kind: "tool.result", toolId: "t2", status: "denied", output: "Refused by the role researcher (role.read-only): this role cannot edit files." }),
    e(500, { kind: "tool.result", toolId: "d1", status: "ok", output: "format.ts builds the total", durationMs: 400 }),
    e(600, { kind: "tool.start", toolId: "d2", name: "Agent", toolKind: "other", input: { subagent_type: "developer", description: "use Intl.NumberFormat" } }),
    e(650, { kind: "tool.start", toolId: "t3", name: "Edit", toolKind: "edit", input: { file_path: "src/utils/format.ts" }, parentToolId: "d2" }, msg(SONNET)),
    e(900, { kind: "tool.result", toolId: "t3", status: "ok", output: "Edited 1 file", diff: { path: "src/utils/format.ts", old: "a", new: "b" }, durationMs: 250 }),
    e(950, { kind: "tool.result", toolId: "d2", status: "ok", output: "done", durationMs: 350 }),
    e(1000, { kind: "tool.start", toolId: "d3", name: "Agent", toolKind: "other", input: { subagent_type: "reviewer", description: "check the change" } }),
    e(1050, { kind: "tool.start", toolId: "t4", name: "Read", toolKind: "read", input: { file_path: "src/utils/format.ts" }, parentToolId: "d3" }, msg(OPUS)),
    e(1100, { kind: "tool.result", toolId: "t4", status: "ok", output: "…", durationMs: 50 }),
    e(1150, { kind: "tool.result", toolId: "d3", status: "ok", output: "fine", durationMs: 150 }),
    e(1200, {
      kind: "usage",
      usage: {
        model: SONNET,
        costBasis: "estimated",
        perTurn: counts(9000, 1100, 0.04),
        cumulative: counts(9000, 1100, 0.04),
        perModel: [
          { model: SONNET, tokens: counts(6000, 800, 0.03) },
          { model: HAIKU, tokens: counts(3000, 300, 0.01) },
        ],
      },
    }),
    e(1250, { kind: "turn.end", stopReason: "endTurn" }),
  ];
}
