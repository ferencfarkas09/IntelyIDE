// Pure mapping of Codex app-server notifications to normalized AgentEvents (providers-plan 1.5). No process, no I/O:
// golden/fake tests feed recorded messages through mapNotification() and compare the output. `raw` keeps the untouched
// message (redacted, size-capped) on the first event of each notification.
import { redact, redactDeep, truncate } from '../../redact.js';
import type { CostBasis, ErrorClass, EventInput, StatusState, StopReason, UsageRecord, UsageTotals } from '../../types.js';
import { changedPaths, itemKind } from './intent.js';
import { isObj, type Json, str } from './wire.js';

export interface MapState {
  now: () => number;
  cwd: string;
  costBasis: CostBasis;
  model: string;
  rawCapBytes: number;
  /** Items seen: kind of tool, start time, file-change paths (the approval request carries only the item id). */
  items: Map<string, { name: string; at: number; paths: string[] }>;
  /** Tool ids refused by policy or the user; their result is "denied" even if Codex reports something else. */
  denied: Set<string>;
  streamed: Set<string>;
  usageLast?: Json;
  usageTotal?: Json;
  contextSize?: number;
  cumulative: UsageTotals;
  status?: StatusState;
  turnError?: { class: ErrorClass; message: string; retryable: boolean };
  /** Shapes that did not match what the adapter relies on (schema drift), by method; reported once each. */
  drift: Set<string>;
}

const zero = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0 });

export function newMapState(over: Partial<MapState> = {}): MapState {
  return {
    now: Date.now, cwd: '/', costBasis: 'included', model: '', rawCapBytes: 16 * 1024,
    items: new Map(), denied: new Set(), streamed: new Set(), cumulative: zero(), drift: new Set(), ...over,
  };
}

function capRaw(method: string, params: Json, cap: number): unknown {
  const s = JSON.stringify(redactDeep({ method, params }));
  return s.length <= cap ? JSON.parse(s) : { _truncated: true, method, bytes: s.length };
}

/** Maps one notification; raw is attached to the first event produced. */
export function mapNotification(state: MapState, method: string, params: Json): EventInput[] {
  const out = map(state, method, params);
  if (out.length) out[0] = { ...out[0], raw: capRaw(method, params, state.rawCapBytes) } as EventInput;
  return out;
}

const driftEvent = (state: MapState, method: string, why: string): EventInput[] => {
  if (state.drift.has(method)) return [];
  state.drift.add(method);
  return [{ kind: 'error', class: 'protocol', message: `unexpected Codex message shape: ${method} (${why})`, retryable: false }];
};

export function errorClassOf(info: unknown): { class: ErrorClass; retryable: boolean } {
  const name = typeof info === 'string' ? info : isObj(info) ? Object.keys(info)[0] : undefined;
  switch (name) {
    case 'unauthorized': return { class: 'auth', retryable: false };
    case 'usageLimitExceeded': case 'serverOverloaded': return { class: 'rate', retryable: name === 'serverOverloaded' };
    case 'httpConnectionFailed': case 'responseStreamConnectionFailed': case 'responseStreamDisconnected': case 'responseTooManyFailedAttempts': return { class: 'network', retryable: true };
    case 'badRequest': case 'contextWindowExceeded': case 'threadRollbackFailed': case 'activeTurnNotSteerable': return { class: 'protocol', retryable: false };
    case 'sandboxError': case 'cyberPolicy': case 'sessionBudgetExceeded': return { class: 'policy', retryable: false };
    default: return { class: 'provider', retryable: name === 'internalServerError' };
  }
}

function setStatus(state: MapState, s: StatusState, extra: { retryAfterMs?: number; scope?: string } = {}): EventInput[] {
  if (state.status === s && !extra.retryAfterMs) return [];
  state.status = s;
  return [{ kind: 'status', state: s, ...extra }];
}

const tokens = (b: Json | undefined): UsageTotals => ({
  inputTokens: Number(b?.inputTokens ?? 0), outputTokens: Number(b?.outputTokens ?? 0), cacheRead: Number(b?.cachedInputTokens ?? 0),
  cacheWrite: Number(b?.cacheWriteInputTokens ?? 0), reasoningTokens: Number(b?.reasoningOutputTokens ?? 0),
});

/** UsageRecord of the turn that just ended from the last tokenUsage update; null when none arrived. Tokens only: no cost, never 0. */
export function usageOf(state: MapState): UsageRecord | null {
  if (!state.usageTotal || !state.usageLast) return null;
  const cum = tokens(state.usageTotal);
  state.cumulative = cum;
  return {
    model: state.model, costBasis: state.costBasis, perTurn: tokens(state.usageLast), cumulative: cum,
    ...(state.contextSize ? { contextSize: state.contextSize } : {}),
    ...(state.usageLast?.totalTokens !== undefined ? { contextUsed: Number(state.usageLast.totalTokens) } : {}),
  };
}

const statusOfItem = (item: Json): 'ok' | 'error' | 'denied' | 'cancelled' | 'running' => {
  switch (item.status) {
    case 'declined': return 'denied';
    case 'failed': return 'error';
    case 'inProgress': return 'running';
    case 'completed': return item.type === 'commandExecution' && typeof item.exitCode === 'number' && item.exitCode !== 0 ? 'error' : 'ok';
    default: return 'ok';
  }
};

function startTool(state: MapState, item: Json): EventInput[] {
  const id = str(item.id);
  const k = itemKind(item);
  if (!id || !k) return [];
  if (state.items.has(id)) return [];
  const paths = item.type === 'fileChange' ? changedPaths(state.cwd, item.changes) : [];
  state.items.set(id, { name: k.name, at: state.now(), paths });
  let input: unknown;
  switch (item.type) {
    case 'commandExecution': input = { command: redact(String(item.command ?? '')), cwd: item.cwd }; break;
    case 'fileChange': input = { paths }; break;
    case 'mcpToolCall': input = redactDeep(item.arguments ?? {}); break;
    case 'webSearch': input = { query: item.query }; break;
    default: input = redactDeep(item.arguments ?? {});
  }
  return [{ kind: 'tool.start', toolId: id, name: k.name, toolKind: k.kind, input }];
}

function finishTool(state: MapState, item: Json): EventInput[] {
  const id = str(item.id);
  const k = itemKind(item);
  if (!id || !k) return [];
  const out = startTool(state, item); // an item that completes without a start still gets a pair
  const seen = state.items.get(id);
  let status = statusOfItem(item);
  if (state.denied.has(id)) status = 'denied';
  let output: string | undefined;
  let diff: { path: string; old: null; new: string } | undefined;
  switch (item.type) {
    case 'commandExecution': output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : undefined; break;
    case 'fileChange': {
      const changes: Json[] = Array.isArray(item.changes) ? item.changes.filter(isObj) : [];
      // `diff` is a unified diff for updates and the content for additions: only an addition fits the old/new shape.
      const add = changes.find((c) => c.kind?.type === 'add');
      if (add && changes.length === 1 && status === 'ok') diff = { path: String(add.path), old: null, new: truncate(String(add.diff ?? ''), 64 * 1024) };
      output = changes.map((c) => `${c.kind?.type ?? 'change'} ${c.path}`).join('\n');
      break;
    }
    case 'mcpToolCall': output = item.error?.message ? String(item.error.message) : item.result ? JSON.stringify(redactDeep(item.result)) : undefined; break;
    default:
  }
  const durationMs = typeof item.durationMs === 'number' ? item.durationMs : seen ? Math.max(0, state.now() - seen.at) : undefined;
  out.push({
    kind: 'tool.result', toolId: id, status: status === 'running' ? 'ok' : status,
    ...(output ? { output: redact(truncate(output, 8000)) } : {}),
    ...(diff ? { diff } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
  return out;
}

function map(state: MapState, method: string, p: Json): EventInput[] {
  switch (method) {
    case 'turn/started': return setStatus(state, 'thinking');
    case 'turn/completed': return mapTurnCompleted(state, p);
    case 'item/started': {
      if (!isObj(p.item)) return driftEvent(state, method, 'no item');
      return startTool(state, p.item);
    }
    case 'item/completed': {
      const item = p.item;
      if (!isObj(item)) return driftEvent(state, method, 'no item');
      if (item.type === 'agentMessage') {
        const id = str(item.id);
        if (!id) return driftEvent(state, method, 'agentMessage without id');
        // text the model produced without a stream still has to appear once
        return [{ kind: 'text.done', messageId: id, text: String(item.text ?? '') }];
      }
      if (item.type === 'reasoning') {
        const id = str(item.id);
        const summary = Array.isArray(item.summary) ? item.summary.filter((s: unknown) => typeof s === 'string').join('\n') : '';
        return id && summary && !state.streamed.has(`r:${id}`) ? [{ kind: 'thinking.delta', messageId: id, text: summary }] : [];
      }
      if (item.type === 'contextCompaction') return setStatus(state, 'compacting');
      return finishTool(state, item);
    }
    case 'item/agentMessage/delta': {
      const id = str(p.itemId);
      if (!id || typeof p.delta !== 'string') return driftEvent(state, method, 'itemId/delta');
      state.streamed.add(`m:${id}`);
      return [...setStatus(state, 'running'), { kind: 'text.delta', messageId: id, text: p.delta }];
    }
    case 'item/reasoning/summaryTextDelta': {
      const id = str(p.itemId);
      if (!id || typeof p.delta !== 'string') return driftEvent(state, method, 'itemId/delta');
      state.streamed.add(`r:${id}`);
      return [{ kind: 'thinking.delta', messageId: id, text: p.delta }];
    }
    case 'item/commandExecution/outputDelta': {
      const id = str(p.itemId);
      if (!id || typeof p.delta !== 'string') return driftEvent(state, method, 'itemId/delta');
      return state.items.has(id) ? [{ kind: 'tool.update', toolId: id, status: 'running', output: redact(truncate(p.delta, 4000)) }] : [];
    }
    case 'thread/tokenUsage/updated': {
      const tu = p.tokenUsage;
      if (!isObj(tu) || !isObj(tu.total) || !isObj(tu.last)) return driftEvent(state, method, 'tokenUsage');
      state.usageLast = tu.last;
      state.usageTotal = tu.total;
      if (typeof tu.modelContextWindow === 'number') state.contextSize = tu.modelContextWindow;
      return [];
    }
    case 'turn/plan/updated': {
      if (!Array.isArray(p.plan)) return driftEvent(state, method, 'plan');
      return [{ kind: 'plan', items: p.plan.filter(isObj).map((s) => ({ content: String(s.step ?? ''), ...(s.status ? { status: String(s.status) } : {}) })) }];
    }
    case 'error': return mapError(state, p);
    case 'model/rerouted': {
      const to = str(p.toModel) ?? str(p.model) ?? str(p.to);
      if (!to) return [];
      state.model = to;
      return [{ kind: 'session.info', effective: { model: to } }];
    }
    case 'account/rateLimits/updated': {
      const r = isObj(p.rateLimits) ? p.rateLimits : undefined;
      if (!r?.rateLimitReachedType && !r?.spendControlReached) return [];
      const resets = [r.primary?.resetsAt, r.secondary?.resetsAt].filter((n): n is number => typeof n === 'number');
      const retryAfterMs = resets.length ? Math.max(0, Math.min(...resets) * 1000 - state.now()) : undefined;
      return setStatus(state, 'throttled', { ...(retryAfterMs !== undefined ? { retryAfterMs } : {}), ...(r.rateLimitReachedType ? { scope: String(r.rateLimitReachedType) } : {}) });
    }
    default: return []; // thread/*, mcp, fs, hook, warning, ...: nothing the transcript shows
  }
}

function mapError(state: MapState, p: Json): EventInput[] {
  const e = isObj(p.error) ? p.error : {};
  const cls = errorClassOf(e.codexErrorInfo);
  const message = redact(String(e.message ?? 'Codex reported an error'));
  if (p.willRetry === true) return setStatus(state, 'retrying');
  state.turnError = { class: cls.class, message, retryable: cls.retryable };
  return [{ kind: 'error', class: cls.class, message, retryable: cls.retryable }];
}

function mapTurnCompleted(state: MapState, p: Json): EventInput[] {
  const t = isObj(p.turn) ? p.turn : undefined;
  if (!t) return driftEvent(state, 'turn/completed', 'no turn');
  const out: EventInput[] = [];
  let stop: StopReason;
  switch (t.status) {
    case 'completed': stop = 'endTurn'; break;
    case 'interrupted': stop = 'cancelled'; break;
    default: {
      stop = 'error';
      // a failed turn that was not announced by an `error` notification still reports why
      if (!state.turnError) {
        const e = isObj(t.error) ? t.error : {};
        const cls = errorClassOf(e.codexErrorInfo);
        out.push({ kind: 'error', class: cls.class, message: redact(String(e.message ?? `turn ${String(t.status)}`)), retryable: cls.retryable });
      }
    }
  }
  state.turnError = undefined;
  const usage = usageOf(state);
  if (usage) out.push({ kind: 'usage', usage });
  state.usageLast = undefined;
  out.push(...setStatus(state, 'idle'));
  out.push({ kind: 'turn.end', stopReason: stop });
  return out;
}
