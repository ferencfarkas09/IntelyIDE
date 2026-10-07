// Context cockpit model: what a run's context holds, folded from its events. Pure and client-side: every number comes
// from an event or is labelled an estimate, and a missing usage event gives `undefined`, never a zero.
import type { AgentEvent, AttachmentRef, CostBasis, ToolKind } from "../../store/agent-types";

export interface FileStat {
  path: string;
  reads: number;
  edits: number;
  /** Characters the read results brought into the context. */
  readChars: number;
}

export interface ToolStat {
  name: string;
  kind: ToolKind;
  calls: number;
  errors: number;
  /** Characters of input and output: the weight the estimates are shared by. */
  chars: number;
  /** Estimated share of the run's tokens and cost (shared out by `chars` within each turn); absent when no turn had usage. */
  estTokens?: number;
  estCostUsd?: number;
}

export interface TurnStat {
  index: number;
  tools: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  costUsd?: number;
  /** The context size the provider reported at the end of this turn. */
  contextUsed?: number;
}

export type ContextSource = "reported" | "estimated" | "unknown";

export interface ContextFill {
  used?: number;
  size?: number;
  /** 0..1, only when both are known. */
  fraction?: number;
  source: ContextSource;
}

export type WarningKind = "contextHigh" | "contextCritical" | "repeatedReads" | "noUsage";

export interface CockpitWarning {
  kind: WarningKind;
  /** Values for the message: the percentage, or the file and its read count. */
  params: Record<string, string | number>;
}

export interface Cockpit {
  files: FileStat[];
  tools: ToolStat[];
  turns: TurnStat[];
  attachments: AttachmentRef[];
  context: ContextFill;
  totals?: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; costUsd?: number; basis: CostBasis; model: string };
  warnings: CockpitWarning[];
  toolCalls: number;
}

export const WARN_FRACTION = 0.8;
export const CRITICAL_FRACTION = 0.95;
/** A file read this many times, each time with at least `LARGE_READ_CHARS`, is "many repeated large reads". */
export const REPEAT_READS = 3;
export const LARGE_READ_CHARS = 4_000;
/** Rough characters per token for the text-based estimate. */
const CHARS_PER_TOKEN = 4;

/** The window of a model, when the model name says it (`[1m]` or `-1m` is the 1M window); undefined for an unknown model. */
export function contextWindow(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const m = model.toLowerCase();
  if (/(\[1m\]|-1m\b|1m-context)/.test(m)) return 1_000_000;
  if (/(opus|sonnet|haiku|claude)/.test(m)) return 200_000;
  return undefined;
}

const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "file"] as const;

function inputPath(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  for (const k of PATH_KEYS) {
    const v = (input as Record<string, unknown>)[k];
    if (typeof v === "string" && v) return v;
  }
  return undefined;
}

const size = (v: unknown): number => {
  if (v === undefined || v === null) return 0;
  try {
    return typeof v === "string" ? v.length : JSON.stringify(v).length;
  } catch {
    return 0;
  }
};

interface Open {
  name: string;
  kind: ToolKind;
  path?: string;
  chars: number;
}

export function buildCockpit(events: readonly AgentEvent[], model?: string): Cockpit {
  const files = new Map<string, FileStat>();
  const tools = new Map<string, ToolStat>();
  const open = new Map<string, Open>();
  const attachments: AttachmentRef[] = [];
  const turns: TurnStat[] = [];
  // Tools of the turn in progress, with their weight: shared out when the turn's usage arrives.
  let pending: { name: string; chars: number }[] = [];
  let totals: Cockpit["totals"];
  let reported: { used?: number; size?: number } = {};
  let textChars = 0;
  let toolCalls = 0;
  let usedModel = model;

  const fileOf = (path: string): FileStat => {
    let f = files.get(path);
    if (!f) files.set(path, (f = { path, reads: 0, edits: 0, readChars: 0 }));
    return f;
  };

  for (const e of events) {
    switch (e.kind) {
      case "user.message":
        textChars += e.text.length;
        for (const a of e.attachments ?? []) attachments.push(a);
        break;
      case "text.done":
        textChars += e.text.length;
        break;
      case "tool.start": {
        toolCalls += 1;
        const path = inputPath(e.input);
        const chars = size(e.input);
        open.set(e.toolId, { name: e.name, kind: e.toolKind, path, chars });
        let s = tools.get(e.name);
        if (!s) tools.set(e.name, (s = { name: e.name, kind: e.toolKind, calls: 0, errors: 0, chars: 0 }));
        s.calls += 1;
        s.chars += chars;
        pending.push({ name: e.name, chars });
        textChars += chars;
        break;
      }
      case "tool.result": {
        const o = open.get(e.toolId);
        if (!o) break;
        const out = size(e.output);
        const s = tools.get(o.name);
        if (s) {
          s.chars += out;
          if (e.status === "error") s.errors += 1;
        }
        const last = [...pending].reverse().find((p) => p.name === o.name);
        if (last) last.chars += out;
        textChars += out;
        const path = e.diff?.path ?? o.path;
        if (path && e.status === "ok") {
          if (o.kind === "read") {
            const f = fileOf(path);
            f.reads += 1;
            f.readChars += out;
          } else if (o.kind === "edit" || o.kind === "delete" || o.kind === "move" || e.diff) {
            fileOf(path).edits += 1;
          }
        }
        break;
      }
      case "usage": {
        const u = e.usage;
        usedModel = u.model || usedModel;
        const turn: TurnStat = {
          index: turns.length + 1,
          tools: pending.length,
          inputTokens: u.perTurn.inputTokens,
          outputTokens: u.perTurn.outputTokens,
          cacheRead: u.perTurn.cacheRead,
          ...(u.perTurn.costUsd != null ? { costUsd: u.perTurn.costUsd } : {}),
          ...(u.contextUsed != null ? { contextUsed: u.contextUsed } : {}),
        };
        turns.push(turn);
        const weight = pending.reduce((n, p) => n + p.chars, 0);
        if (weight > 0) {
          const tokens = (u.perTurn.inputTokens ?? 0) + (u.perTurn.outputTokens ?? 0);
          for (const p of pending) {
            const s = tools.get(p.name);
            if (!s) continue;
            const share = p.chars / weight;
            s.estTokens = (s.estTokens ?? 0) + tokens * share;
            if (u.perTurn.costUsd != null) s.estCostUsd = (s.estCostUsd ?? 0) + u.perTurn.costUsd * share;
          }
        }
        pending = [];
        totals = { inputTokens: u.cumulative.inputTokens, outputTokens: u.cumulative.outputTokens, cacheRead: u.cumulative.cacheRead, cacheWrite: u.cumulative.cacheWrite, ...(u.cumulative.costUsd != null ? { costUsd: u.cumulative.costUsd } : {}), basis: u.costBasis, model: u.model };
        if (u.contextUsed != null || u.contextSize != null) reported = { used: u.contextUsed ?? reported.used, size: u.contextSize ?? reported.size };
        break;
      }
      default:
        break;
    }
  }

  // The window: what the provider reported, else what the model name says; the used part: reported, else a text estimate.
  const windowSize = reported.size ?? contextWindow(usedModel);
  let context: ContextFill;
  if (reported.used !== undefined) context = { used: reported.used, size: windowSize, source: "reported" };
  else if (textChars > 0) context = { used: Math.round(textChars / CHARS_PER_TOKEN), size: windowSize, source: "estimated" };
  else context = { size: windowSize, source: "unknown" };
  if (context.used !== undefined && context.size) context.fraction = Math.min(1.5, context.used / context.size);

  const warnings: CockpitWarning[] = [];
  if (context.fraction !== undefined && context.fraction >= CRITICAL_FRACTION) warnings.push({ kind: "contextCritical", params: { percent: Math.round(context.fraction * 100) } });
  else if (context.fraction !== undefined && context.fraction >= WARN_FRACTION) warnings.push({ kind: "contextHigh", params: { percent: Math.round(context.fraction * 100) } });
  const fileList = [...files.values()].sort((a, b) => b.reads + b.edits - (a.reads + a.edits) || a.path.localeCompare(b.path));
  for (const f of fileList) {
    if (f.reads >= REPEAT_READS && f.readChars / f.reads >= LARGE_READ_CHARS) warnings.push({ kind: "repeatedReads", params: { path: f.path, count: f.reads } });
  }
  if (toolCalls > 0 && !totals) warnings.push({ kind: "noUsage", params: {} });

  return {
    files: fileList,
    tools: [...tools.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
    turns,
    attachments,
    context,
    totals,
    warnings,
    toolCalls,
  };
}
