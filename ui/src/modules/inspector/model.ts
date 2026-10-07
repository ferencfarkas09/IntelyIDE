import { diffLines } from "../../components/chat/diffLines";
import { modelLabel, toolSummary } from "../../components/chat/format";
import { t } from "../../i18n";
import { resolveRepoPath, type RepoRoot } from "../../store/touched";
import type { AgentEvent, DelegateInfo, ErrorClass, PermissionMode, StopReason, ToolKind, ToolStatus, UsageRecord } from "../../store/agent-types";

export { resolveRepoPath, type RepoRoot, type ResolvedPath } from "../../store/touched";

export interface ToolNode {
  toolId: string;
  name: string;
  toolKind: ToolKind;
  summary?: string;
  status: ToolStatus;
  startedMs: number;
  durationMs?: number;
  output?: string;
  parentToolId?: string;
  /** Path the tool reported in its input, used when the result carries no diff. */
  path?: string;
  /** The role this call belongs to: the `subagent_type` of an `Agent` call, inherited by the calls made inside it. */
  role?: string;
  /** The model the role is configured with (the run's delegate table). */
  model?: string;
  /** The model the provider reported for the call (`raw.message.model`); absent when it did not say. */
  actualModel?: string;
  /** Set when the broker or the user refused the call: who decided, by which rule, and in which role. */
  refused?: { by: string; rule?: string; role?: string };
  children: ToolNode[];
  depth: number;
}

export interface TouchedFile {
  /** Repo-relative when the repo is known. */
  repoId: string | undefined;
  path: string;
  edits: number;
  created: boolean;
  deleted: boolean;
  additions: number;
  deletions: number;
  /** First `old` and last `new` of the run's diffs for this file: what the review compares. */
  diffs: { old: string | null; new: string }[];
  toolIds: string[];
}

export interface InitFacts {
  model: string;
  effort?: string;
  permission: string;
  sandbox?: string;
  auth?: { mode: string; source: string; warning?: string };
  assertions: string[];
  mcp: { name: string; status: string }[];
  hooks: string[];
  nativeId?: string;
}

/** One role of the run: the delegate table joined with what its calls did. */
export interface RoleRow {
  name: string;
  model?: string;
  effort?: string | null;
  permission?: PermissionMode;
  color?: string | null;
  scope?: DelegateInfo["scope"];
  calls: number;
  refused: number;
  /** Models the provider reported for its calls. */
  actualModels: string[];
}

export interface CostRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface IssueEntry {
  key: string;
  kind: "error" | "toolError" | "throttle" | "modelMismatch";
  atMs: number;
  title: string;
  detail?: string;
  class?: ErrorClass;
  retryable?: boolean;
  /** Throttle only. */
  untilMs?: number;
}

export interface Inspection {
  runId: string;
  prompt?: string;
  init?: InitFacts;
  roots: ToolNode[];
  tools: ToolNode[];
  files: TouchedFile[];
  issues: IssueEntry[];
  usage?: UsageRecord;
  /** The delegate table of the latest `session.info`; empty for a single-role run. */
  delegates: DelegateInfo[];
  /** Roles of this run with their calls, and cost per model (the provider reports cost per model, not per role). */
  roles: RoleRow[];
  costByModel: CostRow[];
  /** Latest `rssBytes` any event carried in its raw message; the sidecar reports it, not every provider does. */
  rssBytes?: number;
  startedMs?: number;
  endedMs?: number;
  title?: string;
  turns: number;
  eventCount: number;
  finished: boolean;
  stopReason?: StopReason;
}

const rec = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function pathOf(input: unknown): string | undefined {
  const o = rec(input);
  return str(o?.file_path) ?? str(o?.path) ?? str(o?.notebook_path);
}

function mcpOf(raw: Record<string, unknown> | undefined): InitFacts["mcp"] {
  const list = raw?.mcp_servers;
  if (!Array.isArray(list)) return [];
  return list.flatMap((m) => {
    const o = rec(m);
    const name = str(o?.name);
    return name ? [{ name, status: str(o?.status) ?? "unknown" }] : typeof m === "string" ? [{ name: m, status: "unknown" }] : [];
  });
}

function hooksOf(raw: Record<string, unknown> | undefined): string[] {
  const list = raw?.hooks;
  if (!Array.isArray(list)) return [];
  return list.flatMap((h) => (typeof h === "string" ? [h] : str(rec(h)?.name) ? [str(rec(h)?.name)!] : []));
}

/** Folds an event log into everything the Inspector shows. Pure: the same events always give the same result. */
export function buildInspection(runId: string, events: readonly AgentEvent[], ctx: { repoIds: readonly string[]; roots: readonly RepoRoot[]; exists?: (repoId: string, path: string) => boolean }): Inspection {
  const nodes = new Map<string, ToolNode>();
  const order: ToolNode[] = [];
  const files = new Map<string, TouchedFile>();
  const issues: IssueEntry[] = [];
  const out: Inspection = { runId, roots: [], tools: order, files: [], issues, delegates: [], roles: [], costByModel: [], turns: 0, eventCount: events.length, finished: false };
  /** toolId -> the actor of its permission request, for calls the broker refused. */
  const actors = new Map<string, string>();
  let openThrottle: IssueEntry | undefined;
  const reqTool = new Map<string, string>();

  for (const e of events) {
    out.startedMs ??= e.ts;
    out.endedMs = e.ts;
    const raw = rec(e.raw);
    if (typeof raw?.rssBytes === "number") out.rssBytes = raw.rssBytes;
    if (openThrottle && (e.kind !== "status" || (e.state !== "throttled" && e.state !== "retrying"))) {
      openThrottle.untilMs = e.ts;
      openThrottle = undefined;
    }
    switch (e.kind) {
      case "session.started":
        out.init = {
          model: e.model,
          effort: e.effective.effort ?? undefined,
          permission: e.effective.permission,
          sandbox: e.effective.sandbox ?? undefined,
          auth: e.auth ? { mode: e.auth.mode, source: e.auth.source, warning: e.auth.warning ?? undefined } : undefined,
          assertions: e.assertions ?? [],
          mcp: mcpOf(raw),
          hooks: hooksOf(raw),
          nativeId: e.nativeId ?? undefined,
        };
        break;
      case "session.info":
        if (e.title) out.title = e.title;
        if (e.delegates?.length) out.delegates = e.delegates;
        // A live mode switch (or a plan approval): the Permission fact shows the mode the run is in now, not the one it started in.
        if (e.effective?.permission && out.init) out.init = { ...out.init, permission: e.effective.permission };
        break;
      case "user.message":
        out.prompt ??= e.text;
        out.turns++;
        out.finished = false;
        break;
      case "turn.end":
        out.finished = true;
        out.stopReason = e.stopReason;
        break;
      case "usage":
        out.usage = e.usage;
        break;
      case "permission.request": {
        const actor = e.intent.actor;
        if (actor?.role) actors.set(e.toolId, actor.role);
        reqTool.set(e.reqId, e.toolId);
        break;
      }
      case "permission.resolved": {
        const n = nodes.get(reqTool.get(e.reqId) ?? "");
        if (n && e.outcome === "deny") n.refused = { by: e.by, rule: str((e as { rule?: unknown }).rule), role: actors.get(n.toolId) };
        break;
      }
      case "tool.start": {
        const node: ToolNode = { toolId: e.toolId, name: e.name, toolKind: e.toolKind, summary: toolSummary(e.name, e.input), status: "running", startedMs: e.ts, parentToolId: e.parentToolId ?? undefined, path: pathOf(e.input), children: [], depth: 0 };
        const asked = isAgentTool(e.name) ? str(rec(e.input)?.subagent_type) : undefined;
        if (asked) node.role = asked;
        const actual = str(rec(rec(raw?.message))?.model);
        if (actual) node.actualModel = actual;
        nodes.set(e.toolId, node);
        order.push(node);
        break;
      }
      case "tool.update": {
        const n = nodes.get(e.toolId);
        if (n) n.status = e.status;
        break;
      }
      case "tool.result": {
        const n = nodes.get(e.toolId);
        if (!n) break;
        n.status = e.status;
        n.output = e.output ?? n.output;
        n.durationMs = e.durationMs ?? Math.max(0, e.ts - n.startedMs);
        if (e.status === "ok") {
          if (e.diff) touch(files, e.toolId, e.diff.path, false, { old: e.diff.old ?? null, new: e.diff.new }, ctx);
          else if (n.path && (n.toolKind === "edit" || n.toolKind === "delete" || n.toolKind === "move")) touch(files, e.toolId, n.path, n.toolKind === "delete", undefined, ctx);
        }
        if (e.status === "denied" && !n.refused) n.refused = { by: "unknown", rule: ruleOf(n.output) };
        else if (n.refused && !n.refused.rule) n.refused.rule = ruleOf(n.output);
        if (e.status === "error") issues.push({ key: `tool:${e.toolId}`, kind: "toolError", atMs: e.ts, title: t("inspector.issues.toolFailed", { name: n.name }), detail: n.output });
        break;
      }
      case "error":
        issues.push({ key: `error:${e.seq}`, kind: "error", atMs: e.ts, title: e.message, class: e.class, retryable: e.retryable });
        break;
      case "status":
        if (e.state === "throttled" || e.state === "retrying") {
          openThrottle = { key: `throttle:${e.seq}`, kind: "throttle", atMs: e.ts, title: e.state === "retrying" ? t("inspector.issues.retrying") : t("inspector.issues.throttled"), detail: e.scope ?? undefined, untilMs: e.retryAfterMs ? e.ts + e.retryAfterMs : undefined };
          issues.push(openThrottle);
        }
        break;
      default:
        break;
    }
  }

  for (const n of order) {
    const parent = n.parentToolId ? nodes.get(n.parentToolId) : undefined;
    if (parent) {
      n.depth = parent.depth + 1;
      parent.children.push(n);
    } else out.roots.push(n);
  }
  // Depth of grandchildren follows their parent's, which is only known after the first pass above.
  const setDepth = (n: ToolNode, d: number) => {
    n.depth = d;
    n.children.forEach((c) => setDepth(c, d + 1));
  };
  out.roots.forEach((n) => setDepth(n, 0));
  out.files = [...files.values()];
  resolveRoles(out, nodes);
  return out;
}

function touch(files: Map<string, TouchedFile>, toolId: string, rawPath: string, deleted: boolean, diff: { old: string | null; new: string } | undefined, ctx: { repoIds: readonly string[]; roots: readonly RepoRoot[]; exists?: (repoId: string, path: string) => boolean }): void {
  const r = resolveRepoPath(rawPath, ctx.repoIds, ctx.roots, ctx.exists);
  const key = `${r.repoId ?? ""}\0${r.path}`;
  const f = files.get(key) ?? { repoId: r.repoId, path: r.path, edits: 0, created: false, deleted: false, additions: 0, deletions: 0, diffs: [], toolIds: [] };
  if (!f.toolIds.includes(toolId)) {
    f.toolIds.push(toolId);
    f.edits++;
  }
  if (deleted) f.deleted = true;
  if (diff) {
    if (diff.old === null && f.diffs.length === 0) f.created = true;
    f.diffs.push(diff);
    const lines = diffLines(diff.old ?? "", diff.new);
    f.additions += lines.filter((l) => l.kind === "add").length;
    f.deletions += lines.filter((l) => l.kind === "del").length;
  }
  files.set(key, f);
}

/** The run's wall time the timeline bars are drawn against. */
export function timelineSpan(i: Inspection): { start: number; length: number } {
  const start = i.startedMs ?? 0;
  const end = Math.max(i.endedMs ?? start, ...i.tools.map((t) => t.startedMs + (t.durationMs ?? 0)));
  return { start, length: Math.max(1, end - start) };
}

/** Tool nodes in display order (parents before their children), honouring collapsed subagents. */
export function visibleTools(i: Inspection, collapsed: ReadonlySet<string>): ToolNode[] {
  const rows: ToolNode[] = [];
  const walk = (n: ToolNode) => {
    rows.push(n);
    if (!collapsed.has(n.toolId)) n.children.forEach(walk);
  };
  i.roots.forEach(walk);
  return rows;
}

const isAgentTool = (name: string) => name === "Agent" || name === "Task";
/** The rule id of a refusal: the trailing `(by, rule)` of the broker's text, else an id such as `role.read-only` or `delegate.nested` named in it. */
const ruleOf = (output: string | undefined): string | undefined =>
  /\(\s*[A-Za-z]+\s*,\s*([\w.-]+)\s*\)\s*$/.exec(output ?? "")?.[1] ?? /\b((?:role|delegate|net|exec|write|read|fs|hard)[.-][a-z][a-z.-]*[a-z])\b/i.exec(output ?? "")?.[1];

const FAMILY = /(haiku|sonnet|opus)/;
/** Alias tolerant: `sonnet`, `claude-sonnet-5-5` and `claude-sonnet-5-5-20260101` are the same model. */
export function sameModel(a: string, b: string): boolean {
  const norm = (m: string) => m.toLowerCase().replace(/-\d{8}$/, "");
  const [x, y] = [norm(a), norm(b)];
  if (x === y) return true;
  const [fx, fy] = [FAMILY.exec(x)?.[1], FAMILY.exec(y)?.[1]];
  if (!fx || !fy || fx !== fy) return false;
  // An alias (just the family) matches every version of it; two full ids must agree on the version too.
  return x === fx || y === fy || x.replace(/^claude-/, "") === y.replace(/^claude-/, "");
}

/** Gives every call its role and configured model, builds the roles table and the model mismatch issues. Mutates `out`. */
function resolveRoles(out: Inspection, nodes: Map<string, ToolNode>): void {
  const per = out.usage?.perModel ?? [];
  out.costByModel = per.map((m) => ({ model: m.model, inputTokens: m.tokens.inputTokens, outputTokens: m.tokens.outputTokens, ...(m.tokens.costUsd != null ? { costUsd: m.tokens.costUsd } : {}) }));
  // No delegate table: a single-role run. Its Task calls name provider sub-agent types (explorer), not roles of ours.
  if (out.delegates.length === 0) {
    for (const n of out.tools) if (isAgentTool(n.name)) n.role = undefined;
    return;
  }
  const table = new Map(out.delegates.map((d) => [d.name, d]));
  const rows = new Map<string, RoleRow>();
  const rowOf = (name: string): RoleRow => {
    let r = rows.get(name);
    if (!r) {
      const d = table.get(name);
      r = { name, ...(d ? { model: d.model, effort: d.effort ?? null, permission: d.permission, color: d.color ?? null, scope: d.scope } : {}), calls: 0, refused: 0, actualModels: [] };
      rows.set(name, r);
    }
    return r;
  };
  for (const d of out.delegates) rowOf(d.name);
  const roleOfNode = (n: ToolNode): string | undefined => {
    if (n.role) return n.role;
    const parent = n.parentToolId ? nodes.get(n.parentToolId) : undefined;
    return parent ? roleOfNode(parent) : undefined;
  };
  for (const n of out.tools) {
    // Only an Agent call that names a role has `role` set at this point: it starts the role, its children are what the role did.
    const startsRole = !!n.role;
    const role = n.role ?? roleOfNode(n) ?? n.refused?.role;
    if (!role) continue;
    n.role = role;
    const d = table.get(role);
    if (d) n.model = d.model;
    if (startsRole) continue;
    const r = rowOf(role);
    r.calls++;
    if (n.refused) r.refused++;
    if (n.actualModel && !r.actualModels.includes(n.actualModel)) r.actualModels.push(n.actualModel);
  }
  // The Agent call shows the model its first call ran on.
  for (const n of out.tools) if (isAgentTool(n.name) && n.role && !n.actualModel) n.actualModel = n.children.find((c) => c.actualModel)?.actualModel;
  out.roles = [...rows.values()];
  for (const r of out.roles) {
    const wrong = r.model ? r.actualModels.find((m) => !sameModel(m, r.model!)) : undefined;
    if (wrong) out.issues.push({ key: `model:${r.name}`, kind: "modelMismatch", atMs: out.startedMs ?? 0, title: t("inspector.issue.modelMismatch", { role: r.name, actual: modelLabel(wrong), configured: modelLabel(r.model!) }) });
  }
}
