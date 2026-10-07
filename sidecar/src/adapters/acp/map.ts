// session/update -> normalised AgentEvent (providers-plan 1.5, 3.4). Pure: all state is in MapState, so golden tests need no process.
// Mode, config-option and session-info updates change the session itself and are handled in session.ts.
import type { EventInput, ToolStatus } from '../../types.js';
import { redact, redactDeep, truncate } from '../../redact.js';
import { toolKindOf } from './intent.js';

type Raw = Record<string, any>;

interface ToolMeta { startedAt: number }
interface Segment { kind: 'text' | 'thinking'; id: string; text: string }

export interface MapState {
  tools: Map<string, ToolMeta>;
  /** Tool calls the broker refused: their failed result is reported as "denied", not "error". */
  denied: Set<string>;
  seg?: Segment;
  segN: number;
  /** Latest usage_update (context window), merged into the usage event at the end of the turn. */
  ctx?: { used: number; size: number; costUsd?: number };
  now: () => number;
  /** Current output of one of our terminals, so a terminal tool card shows text instead of an id. */
  terminalText?: (id: string) => string | undefined;
}

export const newMapState = (now: () => number = Date.now): MapState => ({ tools: new Map(), denied: new Set(), segN: 0, now });

/** A new turn starts with no open message segment and no tool memory. */
export function resetTurn(st: MapState): void {
  st.tools.clear();
  st.denied.clear();
  st.seg = undefined;
}

const MAX_INPUT_JSON = 8000;
const SECRET_KEY = /(?:api[_-]?key|secret|token|passw(?:or)?d|passphrase|credential|authorization|private[_-]?key|\bauth\b)/i;
/** redactDeep matches values; a tool input also names its secrets by key (`{env: {API_KEY: "..."}}`), so those go too. */
export function redactKeys(v: unknown, depth = 8): unknown {
  if (depth <= 0 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redactKeys(x, depth - 1));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' && x && SECRET_KEY.test(k) ? '<redacted>' : redactKeys(x, depth - 1)]));
}

function boundedInput(v: unknown): unknown {
  const r = redactKeys(redactDeep(v ?? {}));
  let json = '';
  try { json = JSON.stringify(r) ?? ''; } catch { return {}; }
  return json.length > MAX_INPUT_JSON ? { truncated: true, preview: truncate(json, MAX_INPUT_JSON) } : r;
}

function blockText(b: Raw | undefined): string {
  if (!b) return '';
  switch (b.type) {
    case 'text': return String(b.text ?? '');
    case 'image': return '[image]';
    case 'audio': return '[audio]';
    case 'resource_link': return `[${b.name ?? b.uri ?? 'resource'}]`;
    case 'resource': return b.resource?.text ? String(b.resource.text) : `[${b.resource?.uri ?? 'resource'}]`;
    default: return '';
  }
}

/** Output text of a tool call: its text content plus a string rawOutput, redacted and capped. */
function toolOutput(st: MapState, u: Raw): string | undefined {
  const parts: string[] = [];
  for (const c of u.content ?? []) {
    if (c?.type === 'content') { const t = blockText(c.content); if (t) parts.push(t); }
    else if (c?.type === 'terminal' && c.terminalId) parts.push(st.terminalText?.(String(c.terminalId)) ?? `[terminal ${c.terminalId}]`);
  }
  if (!parts.length && u.rawOutput !== undefined && u.rawOutput !== null) {
    parts.push(typeof u.rawOutput === 'string' ? u.rawOutput : (() => { try { return JSON.stringify(u.rawOutput); } catch { return ''; } })());
  }
  const text = parts.join('\n');
  return text ? truncate(redact(text)) : undefined;
}

function toolDiff(u: Raw): { path: string; old?: string | null; new: string } | undefined {
  const d = (u.content ?? []).find((c: Raw) => c?.type === 'diff');
  if (!d || typeof d.path !== 'string') return undefined;
  return { path: d.path, ...(typeof d.oldText === 'string' ? { old: redact(d.oldText) } : {}), new: redact(String(d.newText ?? '')) };
}

const STATUS: Record<string, ToolStatus> = { pending: 'running', in_progress: 'running', completed: 'ok', failed: 'error' };

/** Closes the open message segment with a text.done (the mapper keeps the text of text segments only). */
export function flushSegment(st: MapState): EventInput[] {
  const s = st.seg;
  st.seg = undefined;
  return s && s.kind === 'text' && s.text ? [{ kind: 'text.done', messageId: s.id, text: s.text }] : [];
}

function chunk(st: MapState, kind: 'text' | 'thinking', u: Raw): EventInput[] {
  const text = redact(blockText(u.content));
  if (!text) return [];
  const out: EventInput[] = [];
  const wantId = typeof u.messageId === 'string' && u.messageId ? u.messageId : undefined;
  if (st.seg && (st.seg.kind !== kind || (wantId && st.seg.id !== wantId))) out.push(...flushSegment(st));
  if (!st.seg) st.seg = { kind, id: wantId ?? `m${++st.segN}`, text: '' };
  st.seg.text += text;
  out.push({ kind: kind === 'text' ? 'text.delta' : 'thinking.delta', messageId: st.seg.id, text });
  return out;
}

export function mapUpdate(st: MapState, u: Raw): EventInput[] {
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': return chunk(st, 'text', u);
    case 'agent_thought_chunk': return chunk(st, 'thinking', u);

    case 'tool_call': {
      const id = String(u.toolCallId);
      const out = flushSegment(st);
      if (st.tools.has(id)) return [...out, ...toolUpdate(st, u)]; // a repeated announcement is an update
      st.tools.set(id, { startedAt: st.now() });
      out.push({ kind: 'tool.start', toolId: id, name: redact(String(u.name ?? u.title ?? u.kind ?? 'tool')).slice(0, 200), toolKind: toolKindOf(u.kind, u.name), input: boundedInput(u.rawInput) });
      const s = STATUS[u.status ?? 'pending'];
      if (s && s !== 'running') out.push(toolResult(st, id, u, s));
      return out;
    }
    case 'tool_call_update': return toolUpdate(st, u);

    case 'plan':
      return [{ kind: 'plan', items: (u.entries ?? []).map((e: Raw) => ({ content: redact(String(e.content ?? '')), status: typeof e.status === 'string' ? e.status : null })) }];

    case 'usage_update':
      if (typeof u.used === 'number' && typeof u.size === 'number') {
        st.ctx = { used: u.used, size: u.size, ...(u.cost && u.cost.currency === 'USD' && typeof u.cost.amount === 'number' ? { costUsd: u.cost.amount } : {}) };
      }
      return [];

    case 'compaction_update':
      return u.status === 'in_progress' || u.status === 'started' ? [{ kind: 'status', state: 'compacting' }] : [];

    // history replay, echoes and kinds this version does not know: accepted and ignored
    default: return [];
  }
}

function toolUpdate(st: MapState, u: Raw): EventInput[] {
  const id = String(u.toolCallId);
  const out: EventInput[] = [];
  if (!st.tools.has(id)) {
    // an update for a call that was never announced (some agents skip tool_call after a permission request)
    out.push(...flushSegment(st));
    st.tools.set(id, { startedAt: st.now() });
    out.push({ kind: 'tool.start', toolId: id, name: redact(String(u.name ?? u.title ?? u.kind ?? 'tool')).slice(0, 200), toolKind: toolKindOf(u.kind, u.name), input: boundedInput(u.rawInput) });
  }
  const s = u.status ? STATUS[u.status] : undefined;
  if (s && s !== 'running') { out.push(toolResult(st, id, u, s)); return out; }
  const output = toolOutput(st, u);
  if (s || output) out.push({ kind: 'tool.update', toolId: id, status: 'running', ...(output ? { output } : {}) });
  return out;
}

function toolResult(st: MapState, id: string, u: Raw, status: ToolStatus): EventInput {
  const meta = st.tools.get(id);
  const output = toolOutput(st, u);
  const diff = toolDiff(u);
  const final: ToolStatus = status === 'error' && st.denied.has(id) ? 'denied' : status;
  return { kind: 'tool.result', toolId: id, status: final, ...(output ? { output } : {}), ...(diff ? { diff } : {}), ...(meta ? { durationMs: Math.max(0, st.now() - meta.startedAt) } : {}) };
}

/** First event of a permission request for a call the agent never announced: open it so the card has a tool to attach to. */
export function ensureTool(st: MapState, tc: Raw): EventInput[] {
  const id = String(tc.toolCallId);
  if (st.tools.has(id)) return [];
  return mapUpdate(st, { ...tc, sessionUpdate: 'tool_call', status: 'pending' });
}
