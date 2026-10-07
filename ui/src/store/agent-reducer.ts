import type {
  AgentEvent,
  AgentState,
  DecidedBy,
  DelegateInfo,
  ErrorClass,
  McpServerInfo,
  NoteState,
  PermissionDecision,
  PermissionMode,
  PermissionOutcome,
  ProviderCaps,
  QuestionAnswer,
  RunStatus,
  SessionAllowOffer,
  StopReason,
  ToolDiff,
  ToolIntent,
  ToolKind,
  ToolStatus,
  UsageRecord,
} from "./agent-types";
import type { AttachmentRef, PermissionOption, PlanItem } from "@intely/protocol";
import { toolSummary } from "../components/chat/format";

interface ItemBase {
  /** Unique within the transcript; also the virtualiser key. */
  key: string;
  ts: number;
}
export interface UserItem extends ItemBase {
  type: "user";
  text: string;
  /** Files attached to the message (metadata; thumbnails load by id from the attachment store). */
  attachments?: AttachmentRef[];
}
export interface TextItem extends ItemBase {
  type: "text";
  text: string;
  done: boolean;
}
export interface ThinkingItem extends ItemBase {
  type: "thinking";
  text: string;
  done: boolean;
}
export interface ToolItem extends ItemBase {
  type: "tool";
  toolId: string;
  name: string;
  toolKind: ToolKind;
  summary?: string;
  input?: unknown;
  status: ToolStatus;
  output?: string;
  diff?: ToolDiff;
  durationMs?: number;
  parentToolId?: string;
}
export interface PermissionItem extends ItemBase {
  type: "permission";
  reqId: string;
  toolId: string;
  intent: ToolIntent;
  options: PermissionDecision[];
  outcome?: PermissionOutcome;
  by?: DecidedBy;
  /** The decision the user picked, kept for the resolved line. */
  decision?: PermissionDecision;
  /** What the "allow always in this session" button would allow (the card states it). */
  sessionAllow?: SessionAllowOffer;
  /** ExitPlanMode only: the full plan text (redacted, at most 64 KiB), whether it was cut, and the working modes the card offers. */
  plan?: string;
  planTruncated?: boolean;
  modes?: PermissionMode[];
  /** ExitPlanMode only: the mode the run had before it went into Plan; the card preselects Edit when it was `edit`, else Ask. */
  prePlanMode?: PermissionMode;
  /** The run mode when the request was made; a denial that arrives after the mode changed is the host withdrawing the card. */
  modeAtRequest?: PermissionMode;
  /** The continuation mode the user approved an ExitPlanMode with, and the note they sent back with a rejection. */
  mode?: PermissionMode;
  feedback?: string;
  /** The host refused the answer: the card stays pending and shows why (`code` is an `EngineError.code`). */
  error?: { code: string; message?: string };
  /** The rules changed while the request waited and the host withdrew it (a tightening switch). */
  withdrawn?: boolean;
}
/** An offered answer; the label is its identity (the SDK answers a question with the chosen label). */
export interface QuestionChoice {
  id: string;
  label: string;
  description?: string;
}
export interface QuestionItem extends ItemBase {
  type: "question";
  reqId: string;
  prompt: string;
  options: QuestionChoice[];
  multi: boolean;
  answer?: QuestionAnswer;
  cancelled?: boolean;
}
export interface PlanEntry {
  content: string;
  status: "pending" | "inProgress" | "done";
}
export interface PlanCardItem extends ItemBase {
  type: "plan";
  items: PlanEntry[];
}
export interface ErrorItem extends ItemBase {
  type: "error";
  class: ErrorClass;
  message: string;
  retryable: boolean;
}
export interface TurnItem extends ItemBase {
  type: "turn";
  stopReason: StopReason;
  /** `maxTurns` only: the steps (tool calls of the run itself, not of its delegates) taken since the last message of the user. */
  steps?: number;
}
/** A note the user added to the lead or to a running subagent; it moves from queued to delivered (or dropped) in place. */
export interface NoteItem extends ItemBase {
  type: "note";
  noteId: string;
  state: NoteState;
  text: string;
  /** The subagent's `Agent` call; absent = the note is for the lead. */
  parentToolId?: string;
  /** Delivered: the tool call it rode on. */
  toolId?: string;
  /** Dropped: `finished`, `turnEnded`, `cancelled` or `error`. */
  reason?: string;
}
export type TranscriptItem = UserItem | TextItem | ThinkingItem | ToolItem | PermissionItem | QuestionItem | PlanCardItem | ErrorItem | TurnItem | NoteItem;

export interface Throttle {
  /** `throttled` is the provider asking to slow down; `retrying` is a transient failure being retried. */
  state: "throttled" | "retrying";
  since: number;
  retryAfterMs?: number;
  scope?: string;
}

export interface SeqGap {
  from: number;
  to: number;
}

export interface AgentView {
  agentId: string;
  /** Highest `seq` applied; events at or below it are duplicates and ignored. */
  lastSeq: number;
  gaps: SeqGap[];
  duplicates: number;
  items: TranscriptItem[];
  /** key -> index into `items`. */
  index: Record<string, number>;
  state: AgentState;
  turnActive: boolean;
  throttle?: Throttle;
  usage?: UsageRecord;
  title?: string;
  /** Capabilities computed for this session (`session.info`); beat the static ones of the run list. */
  caps?: ProviderCaps;
  /** The roles the lead could hand work to (`session.info.delegates`); the latest table wins (a resumed run rebuilds it). */
  delegates?: DelegateInfo[];
  /** The CLI's slash commands (`session.info.slashCommands`, names without the slash); the latest list wins. */
  slashCommands?: string[];
  /** The run's MCP servers at init (`session.info.mcpServers`); the latest list wins. */
  mcpServers?: McpServerInfo[];
  session?: { nativeId: string; model: string; effective: { effort?: string; permission: string; sandbox?: string } };
  /** The mode the run had before it last went into Plan: the Plan approval card offers it back (Edit) instead of the default (Ask). */
  prePlanMode?: PermissionMode;
  /** Why the host changed the run's mode on its own (a resume narrowed it, the kill switch): shown once above the transcript. */
  banner?: { kind: "resumeDowngrade" | "roleChanged" | "providerLimit"; seq: number };
}

export function emptyView(agentId: string): AgentView {
  return { agentId, lastSeq: 0, gaps: [], duplicates: 0, items: [], index: {}, state: "idle", turnActive: false };
}

const TEXT = (id: string) => `text:${id}`;
const THINK = (id: string) => `think:${id}`;
const TOOL = (id: string) => `tool:${id}`;
const PERM = (id: string) => `perm:${id}`;
const QUEST = (id: string) => `q:${id}`;
const NOTE = (id: string) => `note:${id}`;

/** Provider wording (`in_progress`, `completed`, ...) in the card's three states. */
function planEntry(i: PlanItem): PlanEntry {
  const s = (i.status ?? "").toLowerCase().replace(/[_\s-]/g, "");
  return { content: i.content, status: s === "done" || s === "completed" ? "done" : s === "inprogress" ? "inProgress" : "pending" };
}

/** The options a permission card offers, in the card's wording (the wire says `allow_once` / `allow_run` / `deny`). */
function decisionsOf(options: readonly PermissionOption[] | undefined): PermissionDecision[] {
  if (!options?.length) return ["allowOnce", "deny"];
  return options.map((o) => (o === "allow_once" ? "allowOnce" : o === "allow_run" ? "allowRun" : "deny"));
}

/** The request that leaves plan mode: the lead's ExitPlanMode, never a delegate's. */
export const isExitPlan = (intent: ToolIntent): boolean => intent.tool === "ExitPlanMode" && !intent.actor;

/** A mode change the session reported lands in the live view; one the host made on its own also leaves a banner. */
function foldEffective(v: AgentView, permission: PermissionMode, reason: string | undefined, nativeId: string | undefined, seq: number): void {
  const before = v.session?.effective.permission;
  const session = v.session ?? { nativeId: nativeId ?? "", model: "", effective: { permission } };
  v.session = { ...session, effective: { ...session.effective, permission } };
  if (permission === "readOnly" && before && before !== "readOnly") v.prePlanMode = before as PermissionMode;
  if (reason === "resumeDowngrade" || reason === "roleChanged") v.banner = { kind: reason, seq };
  else if (reason === "provider") v.banner = { kind: "providerLimit", seq };
}

/** Applies one batch. Returns the same object when nothing changed. Pure: the input view is never mutated. */
export function reduceEvents(view: AgentView, events: readonly AgentEvent[]): AgentView {
  let next: AgentView | undefined;
  for (const ev of events) {
    if (ev.seq <= (next ?? view).lastSeq) {
      next = { ...(next ?? view), duplicates: (next ?? view).duplicates + 1 };
      continue;
    }
    next = applyOne(next ?? clone(view), ev);
  }
  return next ?? view;
}

function clone(v: AgentView): AgentView {
  return { ...v, items: v.items.slice(), index: { ...v.index }, gaps: v.gaps.slice() };
}

function applyOne(v: AgentView, ev: AgentEvent): AgentView {
  if (v.lastSeq > 0 && ev.seq > v.lastSeq + 1) v.gaps.push({ from: v.lastSeq + 1, to: ev.seq - 1 });
  v.lastSeq = ev.seq;
  if (ev.kind !== "thinking.delta") closeThinking(v);

  const upsert = <T extends TranscriptItem>(key: string, make: () => T, patch: (item: T) => T): void => {
    const at = v.index[key];
    if (at === undefined) {
      v.index[key] = v.items.length;
      v.items.push(make());
    } else {
      v.items[at] = patch(v.items[at] as T);
    }
  };
  const push = (item: TranscriptItem): void => {
    v.index[item.key] = v.items.length;
    v.items.push(item);
  };
  const update = <T extends TranscriptItem>(key: string, patch: (item: T) => T): void => {
    const at = v.index[key];
    if (at !== undefined) v.items[at] = patch(v.items[at] as T);
  };
  const base = (key: string) => ({ key, ts: ev.ts });

  switch (ev.kind) {
    case "session.started":
      v.session = { nativeId: ev.nativeId ?? "", model: ev.model, effective: { effort: ev.effective.effort ?? undefined, permission: ev.effective.permission, sandbox: ev.effective.sandbox ?? undefined } };
      break;
    case "user.message":
      push({ ...base(`user:${ev.messageId}`), type: "user", text: ev.text, ...(ev.attachments?.length ? { attachments: ev.attachments } : {}) });
      v.turnActive = true;
      v.throttle = undefined;
      break;
    case "text.delta":
      v.turnActive = true;
      upsert<TextItem>(TEXT(ev.messageId), () => ({ ...base(TEXT(ev.messageId)), type: "text", text: ev.text, done: false }), (t) => ({ ...t, text: t.text + ev.text, done: false }));
      break;
    case "text.done":
      update<TextItem>(TEXT(ev.messageId), (t) => ({ ...t, done: true }));
      break;
    case "thinking.delta":
      v.turnActive = true;
      upsert<ThinkingItem>(THINK(ev.messageId), () => ({ ...base(THINK(ev.messageId)), type: "thinking", text: ev.text, done: false }), (t) => ({ ...t, text: t.text + ev.text }));
      break;
    case "tool.start":
      v.turnActive = true;
      upsert<ToolItem>(
        TOOL(ev.toolId),
        () => ({ ...base(TOOL(ev.toolId)), type: "tool", toolId: ev.toolId, name: ev.name, toolKind: ev.toolKind, summary: toolSummary(ev.name, ev.input), input: ev.input, status: "running", parentToolId: ev.parentToolId ?? undefined }),
        (t) => ({ ...t, name: ev.name, toolKind: ev.toolKind, summary: toolSummary(ev.name, ev.input) ?? t.summary, input: ev.input ?? t.input }),
      );
      break;
    case "tool.update":
      update<ToolItem>(TOOL(ev.toolId), (t) => ({ ...t, status: ev.status, output: ev.output ?? t.output }));
      break;
    case "tool.result":
      update<ToolItem>(TOOL(ev.toolId), (t) => ({ ...t, status: ev.status, output: ev.output ?? t.output, diff: ev.diff ? { path: ev.diff.path, old: ev.diff.old ?? null, new: ev.diff.new } : t.diff, durationMs: ev.durationMs ?? t.durationMs }));
      break;
    case "permission.request":
      push({
        ...base(PERM(ev.reqId)),
        type: "permission",
        reqId: ev.reqId,
        toolId: ev.toolId,
        intent: ev.intent,
        options: decisionsOf(ev.options),
        ...(ev.sessionAllow ? { sessionAllow: ev.sessionAllow } : {}),
        ...(ev.plan !== undefined && ev.plan !== null ? { plan: ev.plan } : {}),
        ...(ev.planTruncated ? { planTruncated: true } : {}),
        ...(ev.modes?.length ? { modes: ev.modes } : {}),
        ...(isExitPlan(ev.intent) && v.prePlanMode ? { prePlanMode: v.prePlanMode } : {}),
        ...(v.session ? { modeAtRequest: v.session.effective.permission as PermissionMode } : {}),
      });
      break;
    case "permission.resolved":
      // A denial nobody here asked for, after the run's mode changed, is the host withdrawing a card its tightening made a denial.
      update<PermissionItem>(PERM(ev.reqId), (p) => ({ ...p, outcome: ev.outcome, by: ev.by, ...(ev.outcome === "deny" && !p.decision && p.modeAtRequest && v.session && v.session.effective.permission !== p.modeAtRequest ? { withdrawn: true } : {}) }));
      break;
    case "question.request":
      push({ ...base(QUEST(ev.reqId)), type: "question", reqId: ev.reqId, prompt: ev.prompt, options: (ev.options ?? []).map((o) => ({ id: o.label, label: o.label, description: o.description ?? undefined })), multi: false });
      break;
    case "plan":
      {
        const items = ev.items.map(planEntry);
        upsert<PlanCardItem>("plan", () => ({ ...base("plan"), type: "plan", items }), (p) => ({ ...p, items }));
      }
      break;
    case "note":
      // queued carries the text and opens the item; delivered/dropped update it in place (a replay that starts later makes the item from what it has)
      upsert<NoteItem>(
        NOTE(ev.noteId),
        () => ({ ...base(NOTE(ev.noteId)), type: "note", noteId: ev.noteId, state: ev.state, text: ev.text ?? "", ...(ev.parentToolId ? { parentToolId: ev.parentToolId } : {}), ...(ev.toolId ? { toolId: ev.toolId } : {}), ...(ev.reason ? { reason: ev.reason } : {}) }),
        (n) => ({ ...n, state: ev.state, text: ev.text ?? n.text, ...(ev.parentToolId ? { parentToolId: ev.parentToolId } : {}), ...(ev.toolId ? { toolId: ev.toolId } : {}), ...(ev.reason ? { reason: ev.reason } : {}) }),
      );
      break;
    case "usage":
      v.usage = ev.usage;
      break;
    case "status":
      v.state = ev.state;
      v.throttle = ev.state === "throttled" || ev.state === "retrying" ? { state: ev.state, since: ev.ts, retryAfterMs: ev.retryAfterMs ?? undefined, scope: ev.scope ?? undefined } : undefined;
      if (ev.state !== "idle") v.turnActive = true;
      break;
    case "error":
      push({ ...base(`error:${ev.seq}`), type: "error", class: ev.class, message: ev.message, retryable: ev.retryable });
      break;
    case "turn.end":
      finishTurn(v, ev.stopReason, ev.ts, ev.seq);
      break;
    case "session.info":
      if (ev.title) v.title = ev.title;
      if (ev.caps) v.caps = ev.caps;
      if (ev.delegates?.length) v.delegates = ev.delegates;
      if (ev.slashCommands?.length) v.slashCommands = ev.slashCommands;
      if (ev.mcpServers?.length) v.mcpServers = ev.mcpServers;
      if (ev.effective?.permission) {
        foldEffective(v, ev.effective.permission, ev.effective.reason ?? undefined, ev.nativeId ?? undefined, ev.seq);
        // The approved plan's card names the mode the run continued in (the answer itself carries none after a replay or from the phone).
        if (ev.effective.reason === "planApproved") {
          const at = v.items.map((i) => i.type === "permission" && isExitPlan(i.intent)).lastIndexOf(true);
          const card = v.items[at];
          if (card?.type === "permission" && card.outcome === "allow" && !card.mode) v.items[at] = { ...card, mode: ev.effective.permission };
        }
      }
      break;
  }
  return v;
}

function closeThinking(v: AgentView): void {
  for (let i = v.items.length - 1; i >= 0; i--) {
    const item = v.items[i];
    if (item.type === "thinking" && !item.done) v.items[i] = { ...item, done: true };
    else if (item.type !== "thinking") break;
  }
}

/** Tool calls of the run itself after the last user message: what "step" means in the step-limit row. */
function stepsSinceUser(items: TranscriptItem[]): number {
  let n = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.type === "user") break;
    if (item.type === "tool" && !item.parentToolId) n++;
  }
  return n;
}

/** A turn ends exactly once: whatever is still open is closed so nothing spins or waits forever. */
function finishTurn(v: AgentView, stopReason: StopReason, ts: number, seq: number): void {
  v.items = v.items.map((item) => {
    switch (item.type) {
      case "text":
      case "thinking":
        return item.done ? item : { ...item, done: true };
      case "tool":
        return item.status === "running" ? { ...item, status: "cancelled" as const } : item;
      case "permission":
        return item.outcome ? item : { ...item, outcome: "cancelled" as const, by: "user" as const };
      case "question":
        return item.answer || item.cancelled ? item : { ...item, cancelled: true };
      case "note":
        // the host reports every waiting note as dropped before the turn ends; one still queued here lost its report (a crashed sidecar)
        return item.state === "queued" ? { ...item, state: "dropped" as const, reason: "turnEnded" } : item;
      default:
        return item;
    }
  });
  if (stopReason !== "endTurn") {
    const key = `turn:${seq}`;
    v.index[key] = v.items.length;
    v.items.push({ key, ts, type: "turn", stopReason, ...(stopReason === "maxTurns" ? { steps: stepsSinceUser(v.items) } : {}) });
  }
  v.turnActive = false;
  v.state = "idle";
  v.throttle = undefined;
}

/** Local reply bookkeeping: the permission/question card shows the user's pick immediately. */
export function markPermissionAnswered(view: AgentView, reqId: string, decision: PermissionDecision, extra?: { mode?: PermissionMode; feedback?: string }): AgentView {
  const at = view.index[PERM(reqId)];
  if (at === undefined) return view;
  const item = view.items[at] as PermissionItem;
  if (item.outcome) return view;
  const items = view.items.slice();
  const { error: _cleared, ...rest } = item;
  items[at] = { ...rest, decision, outcome: decision === "deny" ? "deny" : "allow", by: "user", ...(extra?.mode ? { mode: extra.mode } : {}), ...(extra?.feedback ? { feedback: extra.feedback } : {}) };
  return { ...view, items };
}

/**
 * The host refused the answer. `modeChanged` means the rules changed under the card and the host withdrew the request, so the card
 * resolves as withdrawn; any other code puts the card back to pending with the reason, so the user can answer again.
 */
export function markPermissionRefused(view: AgentView, reqId: string, code: string, message?: string): AgentView {
  const at = view.index[PERM(reqId)];
  if (at === undefined) return view;
  const { decision: _d, mode: _m, feedback: _f, ...item } = view.items[at] as PermissionItem;
  const items = view.items.slice();
  items[at] = code === "modeChanged" ? { ...item, outcome: "deny", by: "user", withdrawn: true, error: { code, message } } : { ...item, outcome: undefined, by: undefined, error: { code, message } };
  return { ...view, items };
}

export function markQuestionAnswered(view: AgentView, reqId: string, answer: QuestionAnswer): AgentView {
  const at = view.index[QUEST(reqId)];
  if (at === undefined) return view;
  const items = view.items.slice();
  items[at] = { ...(view.items[at] as QuestionItem), answer };
  return { ...view, items };
}

export const pendingPermissions = (v: AgentView): PermissionItem[] => v.items.filter((i): i is PermissionItem => i.type === "permission" && !i.outcome);
export const pendingQuestions = (v: AgentView): QuestionItem[] => v.items.filter((i): i is QuestionItem => i.type === "question" && !i.answer && !i.cancelled);

/** Status shown in the list: waiting on the user beats running beats done; a turn that ended in error stays visible. */
export function runStatus(v: AgentView): RunStatus {
  if (pendingPermissions(v).length || pendingQuestions(v).length) return "needsYou";
  if (v.turnActive) return "running";
  const last = [...v.items].reverse().find((i) => i.type === "turn");
  return last?.type === "turn" && last.stopReason === "error" ? "error" : "done";
}

export interface TranscriptRow {
  key: string;
  item: TranscriptItem;
  /** Tool calls made by a subagent started by this tool item. */
  children: ToolItem[];
  /** Notes the user added to the subagent this tool item started. */
  notes: NoteItem[];
}

/** Top-level rows; tool calls with a known parent move under it (subagents). */
export function buildRows(items: readonly TranscriptItem[]): TranscriptRow[] {
  const parents = new Set(items.filter((i): i is ToolItem => i.type === "tool").map((t) => t.toolId));
  const kids = new Map<string, ToolItem[]>();
  const notes = new Map<string, NoteItem[]>();
  for (const item of items) {
    if (item.type === "tool" && item.parentToolId && parents.has(item.parentToolId)) {
      const list = kids.get(item.parentToolId) ?? [];
      list.push(item);
      kids.set(item.parentToolId, list);
    } else if (item.type === "note" && item.parentToolId && parents.has(item.parentToolId)) {
      const list = notes.get(item.parentToolId) ?? [];
      list.push(item);
      notes.set(item.parentToolId, list);
    }
  }
  const rows: TranscriptRow[] = [];
  for (const item of items) {
    if (item.type === "tool" && item.parentToolId && parents.has(item.parentToolId)) continue;
    if (item.type === "note" && item.parentToolId && parents.has(item.parentToolId)) continue;
    rows.push({ key: item.key, item, children: item.type === "tool" ? (kids.get(item.toolId) ?? []) : [], notes: item.type === "tool" ? (notes.get(item.toolId) ?? []) : [] });
  }
  return rows;
}
