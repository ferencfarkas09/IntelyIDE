// Pure mapping of raw Agent SDK messages to normalized AgentEvents (providers-plan 1.5). No process, no SDK import:
// golden tests feed recorded lines through mapRaw() and compare the output. `raw` keeps the untouched message, size-capped.
import { redact, redactDeep, truncate } from '../../redact.js';
import type { AuthFact, CostBasis, ErrorClass, EventInput, PermissionMode, StatusState, StopReason, UsageRecord, UsageTotals } from '../../types.js';
import { effortOf } from '../../abstract.js';
import { toolKind } from './intent.js';

export type Raw = Record<string, any>;

export interface InitFacts { effort: string | null; auth?: AuthFact; assertions: string[] }

export interface MapState {
  now: () => number;
  costBasis: CostBasis;
  /** Supplies what only the session knows: applied effort (get_settings), credential check, init assertions. */
  describeInit: (init: Raw) => InitFacts;
  /** The IDE mode the session holds; `session.started` reports it, never a value derived from the SDK (which cannot tell Ask from Automatic). */
  mode: () => PermissionMode;
  /** The last assistant text of the lead in this turn: the plan when ExitPlanMode's own input carries none. */
  lastText?: string;
  rawCapBytes: number;
  started: boolean;
  msgId?: string;
  blocks: Map<number, string>;
  assistantBlocks: Map<string, number>;
  streamed: Set<string>;
  tools: Map<string, { name: string; input: Raw; at: number }>;
  /** Tool ids refused by policy or the user; their error result is reported as "denied". */
  denied: Set<string>;
  prevUsage: Map<string, Raw>;
  cumulative: UsageTotals;
  status?: StatusState;
  errorThisTurn: boolean;
}

export function newMapState(over: Partial<MapState> = {}): MapState {
  return {
    now: Date.now,
    costBasis: 'subscription',
    describeInit: () => ({ effort: null, assertions: [] }),
    mode: () => 'ask',
    rawCapBytes: 16 * 1024,
    started: false,
    blocks: new Map(),
    assistantBlocks: new Map(),
    streamed: new Set(),
    tools: new Map(),
    denied: new Set(),
    prevUsage: new Map(),
    cumulative: zero(),
    errorThisTurn: false,
    ...over,
  };
}

const zero = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, costUsd: 0 });

function capRaw(raw: Raw, cap: number): unknown {
  const s = JSON.stringify(redactDeep(raw));
  if (s.length <= cap) return JSON.parse(s);
  return { _truncated: true, type: raw.type, subtype: raw.subtype, bytes: s.length };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map((b: Raw) => (b?.type === 'text' ? String(b.text ?? '') : b?.type === 'image' ? '[image]' : '')).filter(Boolean).join('\n');
}

const errorClass = (e: string | undefined): ErrorClass => {
  switch (e) {
    case 'authentication_failed': case 'oauth_org_not_allowed': case 'account_on_hold': case 'verification_required': case 'billing_error': case 'cloud_credential_error': return 'auth';
    case 'rate_limit': case 'overloaded': return 'rate';
    case 'invalid_request': case 'max_output_tokens': case 'model_not_found': return 'protocol';
    default: return 'provider';
  }
};
const statusClass = (s: number | null | undefined): ErrorClass => (s === 401 || s === 403 ? 'auth' : s === 429 ? 'rate' : s && s >= 500 ? 'provider' : 'provider');

function stopFor(r: Raw): { stop: StopReason; error?: { class: ErrorClass; message: string; retryable: boolean } } {
  const tr = r.terminal_reason as string | undefined;
  if (r.subtype === 'success' && !r.is_error) {
    if (r.stop_reason === 'max_tokens') return { stop: 'maxTokens' };
    if (r.stop_reason === 'refusal') return { stop: 'refusal' };
    return { stop: 'endTurn' };
  }
  if (tr === 'aborted_streaming' || tr === 'aborted_tools') return { stop: 'cancelled' };
  if (r.subtype === 'error_max_turns' || tr === 'max_turns') return { stop: 'maxTurns' };
  const status = typeof r.api_error_status === 'number' ? r.api_error_status : null;
  const message = redact(typeof r.result === 'string' && r.result ? r.result : `${r.subtype ?? 'error'}${tr ? ` (${tr})` : ''}`);
  const budget = r.subtype === 'error_max_budget_usd' || tr === 'budget_exhausted';
  return { stop: 'error', error: { class: budget ? 'policy' : statusClass(status), message, retryable: status === 429 || (status !== null && status >= 500) } };
}

function usageOf(state: MapState, r: Raw): UsageRecord | undefined {
  const mu = r.modelUsage as Record<string, Raw> | undefined;
  if (!mu || typeof mu !== 'object') return undefined;
  const per = zero();
  const cum = zero();
  let model = '';
  let best = -1;
  let ctx: number | undefined;
  const add = (t: UsageTotals, e: Raw, prev?: Raw) => {
    const d = (k: string) => Math.max(0, Number(e[k] ?? 0) - Number(prev?.[k] ?? 0));
    t.inputTokens += d('inputTokens');
    t.outputTokens += d('outputTokens');
    t.cacheRead += d('cacheReadInputTokens');
    t.cacheWrite += d('cacheCreationInputTokens');
    t.reasoningTokens += d('thinkingTokens');
    t.costUsd = (t.costUsd ?? 0) + d('costUSD');
  };
  for (const [name, e] of Object.entries(mu)) {
    const prev = state.prevUsage.get(name);
    const before = per.costUsd ?? 0;
    add(per, e, prev);
    add(cum, e);
    const delta = (per.costUsd ?? 0) - before;
    if (delta > best) { best = delta; model = name; }
    if (typeof e.contextWindow === 'number') ctx = e.contextWindow;
  }
  state.prevUsage = new Map(Object.entries(mu));
  state.cumulative = cum;
  // cumulative per model (the CLI reports cost per model, not per role; sub-agents are included in modelUsage)
  const perModel = Object.entries(mu).map(([name, e]) => { const t = zero(); add(t, e); return { model: name, tokens: t }; });
  return { model, costBasis: state.costBasis, ...(ctx ? { contextSize: ctx } : {}), perTurn: per, cumulative: cum, ...(perModel.length ? { perModel } : {}) };
}

function diffFor(name: string, input: Raw): { path: string; old: string | null; new: string } | undefined {
  const cap = (s: unknown) => truncate(String(s ?? ''), 64 * 1024);
  if (name === 'Edit' && typeof input.file_path === 'string') return { path: input.file_path, old: cap(input.old_string), new: cap(input.new_string) };
  if (name === 'Write' && typeof input.file_path === 'string') return { path: input.file_path, old: null, new: cap(input.content) };
  return undefined;
}

function setStatus(state: MapState, s: StatusState, extra: { retryAfterMs?: number; scope?: string } = {}): EventInput[] {
  if (state.status === s && !extra.retryAfterMs) return [];
  state.status = s;
  return [{ kind: 'status', state: s, ...extra }];
}

/** Maps one SDK message. Mutates `state`; returns zero or more events (raw attached to the first). */
export function mapRaw(state: MapState, m: Raw): EventInput[] {
  const out = map(state, m);
  if (out.length) out[0] = { ...out[0], raw: capRaw(m, state.rawCapBytes) } as EventInput;
  return out;
}

function map(state: MapState, m: Raw): EventInput[] {
  const parent: string | undefined = typeof m.parent_tool_use_id === 'string' ? m.parent_tool_use_id : undefined;
  const sub = parent ? { parentToolId: parent } : {};
  switch (m.type) {
    case 'system': return mapSystem(state, m);
    case 'rate_limit_event': {
      const i = m.rate_limit_info ?? {};
      if (i.status !== 'rejected') return [];
      const retryAfterMs = typeof i.resetsAt === 'number' ? Math.max(0, i.resetsAt * 1000 - state.now()) : undefined;
      return setStatus(state, 'throttled', { ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), ...(i.rateLimitType ? { scope: String(i.rateLimitType) } : {}) });
    }
    case 'stream_event': return mapStream(state, m.event ?? {}, sub);
    case 'assistant': return mapAssistant(state, m, parent);
    case 'user': return mapUser(state, m);
    case 'result': return mapResult(state, m);
    default: return [];
  }
}

function mapSystem(state: MapState, m: Raw): EventInput[] {
  switch (m.subtype) {
    case 'init': {
      if (state.started) return [];
      state.started = true;
      const f = state.describeInit(m);
      return [{
        kind: 'session.started',
        nativeId: String(m.session_id),
        model: String(m.model),
        effective: { effort: effortOf(f.effort), permission: state.mode() },
        ...(f.auth ? { auth: f.auth } : {}),
        ...(f.assertions.length ? { assertions: f.assertions } : {}),
      }];
    }
    case 'status':
      if (m.status === 'requesting') return setStatus(state, 'thinking');
      if (m.status === 'compacting') return setStatus(state, 'compacting');
      return [];
    case 'api_retry':
      return setStatus(state, 'retrying', { retryAfterMs: Number(m.retry_delay_ms ?? 0), scope: String(m.error ?? 'api') });
    case 'task_started':
      return [{ kind: 'tool.update', toolId: String(m.tool_use_id), status: 'running', output: truncate(`${m.subagent_type ?? 'subagent'}: ${m.description ?? ''}`, 400) }];
    case 'task_notification':
      return [{ kind: 'tool.update', toolId: String(m.tool_use_id), status: m.status === 'completed' ? 'ok' : 'running', output: truncate(redact(String(m.summary ?? '')), 400) }];
    default: return [];
  }
}

function mapStream(state: MapState, e: Raw, sub: { parentToolId?: string }): EventInput[] {
  switch (e.type) {
    case 'message_start':
      state.msgId = String(e.message?.id ?? '');
      state.blocks.clear();
      return setStatus(state, 'running');
    case 'content_block_start':
      state.blocks.set(Number(e.index), String(e.content_block?.type));
      return [];
    case 'content_block_delta': {
      const messageId = `${state.msgId}:${e.index}`;
      const d = e.delta ?? {};
      if (d.type === 'text_delta' && d.text) { state.streamed.add(messageId); return [{ kind: 'text.delta', messageId, text: redact(String(d.text)), ...sub }]; }
      if (d.type === 'thinking_delta' && d.thinking) { state.streamed.add(messageId); return [{ kind: 'thinking.delta', messageId, text: redact(String(d.thinking)), ...sub }]; }
      return [];
    }
    default: return [];
  }
}

function mapAssistant(state: MapState, m: Raw, parent?: string): EventInput[] {
  const msg = m.message ?? {};
  const out: EventInput[] = [];
  const sub = parent ? { parentToolId: parent } : {};
  for (const b of Array.isArray(msg.content) ? msg.content : []) {
    const n = state.assistantBlocks.get(msg.id) ?? 0;
    state.assistantBlocks.set(msg.id, n + 1);
    const messageId = `${msg.id}:${n}`;
    if (b.type === 'text' && b.text) {
      out.push({ kind: 'text.done', messageId, text: redact(String(b.text)), ...sub });
      if (!parent) state.lastText = String(b.text);
    } else if (b.type === 'thinking' && b.thinking && !state.streamed.has(messageId)) out.push({ kind: 'thinking.delta', messageId, text: redact(String(b.thinking)), ...sub });
    else if (b.type === 'tool_use') {
      state.tools.set(b.id, { name: b.name, input: b.input ?? {}, at: state.now() });
      out.push(toolStart(b, parent));
      if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) {
        out.push({ kind: 'plan', items: b.input.todos.map((t: Raw) => ({ content: String(t.content ?? t.activeForm ?? ''), ...(t.status ? { status: String(t.status) } : {}) })) });
      }
      // ExitPlanMode no longer becomes a `plan` event: the approval card carries the full text (permission.request.plan)
    }
  }
  if (msg.error || m.error) {
    const e = String(m.error ?? msg.error);
    state.errorThisTurn = true;
    out.push({ kind: 'error', class: errorClass(e), message: redact(`${e}${textOf(msg.content) ? `: ${textOf(msg.content)}` : ''}`), retryable: errorClass(e) === 'rate' || e === 'server_error' });
  }
  return out;
}

function toolStart(b: Raw, parent?: string): EventInput {
  return { kind: 'tool.start', toolId: String(b.id), name: String(b.name), toolKind: toolKind(String(b.name)), input: redactDeep(b.input ?? {}), ...(parent ? { parentToolId: parent } : {}) };
}

function mapUser(state: MapState, m: Raw): EventInput[] {
  const out: EventInput[] = [];
  const content = m.message?.content;
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    if (b?.type !== 'tool_result') continue;
    const toolId = String(b.tool_use_id);
    const t = state.tools.get(toolId);
    const status = state.denied.has(toolId) ? 'denied' : b.is_error ? 'error' : 'ok';
    const diff = t && status === 'ok' ? diffFor(t.name, t.input) : undefined;
    out.push({
      kind: 'tool.result',
      toolId,
      status,
      output: truncate(redact(textOf(b.content))),
      ...(diff ? { diff } : {}),
      ...(t ? { durationMs: Math.max(0, state.now() - t.at) } : {}),
    });
  }
  return out;
}

function mapResult(state: MapState, r: Raw): EventInput[] {
  const out: EventInput[] = [];
  const usage = usageOf(state, r);
  if (usage) out.push({ kind: 'usage', usage });
  const { stop, error } = stopFor(r);
  state.lastText = undefined;
  if (error && !state.errorThisTurn) out.push({ kind: 'error', ...error });
  state.errorThisTurn = false;
  out.push(...setStatus(state, 'idle'));
  out.push({ kind: 'turn.end', stopReason: stop });
  return out;
}
