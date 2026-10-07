// Turns the Mac's AgentEvent stream into the calm transcript of the run screen (remote-plan S2): assistant text, tool calls
// collapsed to one line, permission and question rows, errors. Pure and ordered by seq, so a resume or a duplicate is harmless.
import type { AgentEvent } from "./wire";

export type Row =
  | { kind: "user"; id: string; text: string; ts: number }
  | { kind: "assistant"; id: string; text: string; streaming: boolean; ts: number }
  | { kind: "thinking"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; toolKind: string; label: string; status: string; output: string | null; diffPath: string | null; ms: number | null; input: unknown }
  | { kind: "permission"; id: string; reqId: string; toolId: string; summary: string; state: "open" | "allow" | "deny" | "cancelled"; by: string | null }
  | { kind: "question"; id: string; reqId: string; prompt: string; state: "open" | "answered" }
  | { kind: "error"; id: string; message: string }
  | { kind: "turn"; id: string; reason: string };

export interface Transcript {
  rows: Row[];
  lastSeq: number;
  status: string | null;
  /** The last event seq folded in, per row id, to ignore duplicates. */
  seen: number;
}

export const emptyTranscript = (): Transcript => ({ rows: [], lastSeq: 0, status: null, seen: 0 });

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** "Ran npm test", "Edited src/a.ts", "Read 3 files": the one line a collapsed tool shows. */
export function toolLabel(name: string, toolKind: string, input: unknown, status: string): string {
  const i = rec(input);
  const cmd = str(i.command) || str(i.cmd);
  const path = str(i.file_path) || str(i.path) || str(i.filePath);
  const short = (s: string, n = 60) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const tail = status === "error" ? " (failed)" : status === "denied" ? " (denied)" : status === "cancelled" ? " (cancelled)" : "";
  switch (toolKind) {
    case "exec":
      return `Ran ${short(cmd || name)}${tail}`;
    case "edit":
      return `Edited ${short(path || "a file")}${tail}`;
    case "delete":
      return `Deleted ${short(path || "a file")}${tail}`;
    case "move":
      return `Moved ${short(path || "a file")}${tail}`;
    case "read":
      return `Read ${short(path || "a file")}${tail}`;
    case "search":
      return `Searched ${short(str(i.pattern) || str(i.query) || "the project")}${tail}`;
    case "fetch":
      return `Fetched ${short(str(i.url) || "a page")}${tail}`;
    case "think":
      return "Thought";
    default:
      return `${short(name)}${tail}`;
  }
}

/** Folds one event in. Returns the same transcript object (mutated) so callers can wrap it in a store. */
export function apply(t: Transcript, e: AgentEvent): Transcript {
  if (e.seq <= t.seen) return t; // a replay after a reconnect
  t.seen = e.seq;
  t.lastSeq = Math.max(t.lastSeq, e.seq);
  const find = <K extends Row["kind"]>(kind: K, pred: (r: Extract<Row, { kind: K }>) => boolean) => t.rows.find((r): r is Extract<Row, { kind: K }> => r.kind === kind && pred(r as Extract<Row, { kind: K }>));
  switch (e.kind) {
    case "user.message":
      t.rows.push({ kind: "user", id: `u:${e.messageId}`, text: e.text, ts: e.ts });
      break;
    case "text.delta":
    case "text.done": {
      if (e.parentToolId) break; // subagent chatter stays out of the calm view
      let r = find("assistant", (x) => x.id === `a:${e.messageId}`);
      if (!r) {
        r = { kind: "assistant", id: `a:${e.messageId}`, text: "", streaming: true, ts: e.ts };
        t.rows.push(r);
      }
      if (e.kind === "text.delta") r.text += e.text;
      else {
        r.text = e.text;
        r.streaming = false;
      }
      break;
    }
    case "thinking.delta": {
      let r = find("thinking", (x) => x.id === `k:${e.messageId}`);
      if (!r) {
        r = { kind: "thinking", id: `k:${e.messageId}`, text: "" };
        t.rows.push(r);
      }
      r.text += e.text;
      break;
    }
    case "tool.start":
      if (e.parentToolId) break;
      t.rows.push({ kind: "tool", id: `t:${e.toolId}`, name: e.name, toolKind: e.toolKind, label: toolLabel(e.name, e.toolKind, e.input, "running"), status: "running", output: null, diffPath: null, ms: null, input: e.input });
      break;
    case "tool.update":
    case "tool.result": {
      const r = find("tool", (x) => x.id === `t:${e.toolId}`);
      if (!r) break;
      r.status = e.status;
      if (e.output != null) r.output = e.output;
      r.label = toolLabel(r.name, r.toolKind, r.input, e.status);
      if (e.kind === "tool.result") {
        r.diffPath = e.diff?.path ?? r.diffPath;
        r.ms = e.durationMs ?? null;
      }
      break;
    }
    case "permission.request":
      t.rows.push({ kind: "permission", id: `p:${e.reqId}`, reqId: e.reqId, toolId: e.toolId, summary: e.intent.summary, state: "open", by: null });
      break;
    case "permission.resolved": {
      const r = find("permission", (x) => x.reqId === e.reqId);
      if (r) {
        r.state = e.outcome;
        r.by = e.by;
      }
      break;
    }
    case "question.request":
      t.rows.push({ kind: "question", id: `q:${e.reqId}`, reqId: e.reqId, prompt: e.prompt, state: "open" });
      break;
    case "status":
      t.status = e.state;
      break;
    case "error":
      t.rows.push({ kind: "error", id: `e:${e.seq}`, message: e.message });
      break;
    case "turn.end":
      t.rows.push({ kind: "turn", id: `n:${e.seq}`, reason: e.stopReason });
      for (const r of t.rows) if (r.kind === "assistant") r.streaming = false;
      break;
    default:
      break;
  }
  return t;
}

export function fold(events: AgentEvent[], t: Transcript = emptyTranscript()): Transcript {
  for (const e of events) apply(t, e);
  return t;
}

/** Marks a question row answered (the Mac does not send a resolved event for questions). */
export function markQuestionAnswered(t: Transcript, reqId: string): void {
  for (const r of t.rows) if (r.kind === "question" && r.reqId === reqId) r.state = "answered";
}
