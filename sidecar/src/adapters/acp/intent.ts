// ACP tool call -> ToolClass/ToolKind/ToolIntent (providers-plan 5.4). The adapter only classifies and passes the raw command;
// Rust parses and decides. What an agent shows (title) and what it runs (rawInput) can differ, so the raw input wins.
import path from 'node:path';
import type { ToolIntent, ToolKind } from '../../types.js';
import { redact } from '../../redact.js';

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}...` : s);

/** The slice of an ACP ToolCall / ToolCallUpdate the classifier reads. */
export interface AcpToolCall {
  toolCallId: string;
  title?: string | null;
  name?: string | null;
  kind?: string | null;
  rawInput?: unknown;
  locations?: Array<{ path?: string }> | null;
  content?: Array<{ type?: string; path?: string }> | null;
}

export function toolKindOf(kind: string | null | undefined, name?: string | null): ToolKind {
  if (name?.startsWith('mcp__')) return 'mcp';
  switch (kind) {
    case 'read': case 'edit': case 'delete': case 'move': case 'search': case 'fetch': case 'think': return kind;
    case 'execute': return 'exec';
    default: return 'other';
  }
}

/** POSIX single-quote when needed, so Rust's shell parser reads back exactly the argv that will run. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The command line an agent is about to run, from the places agents put it. */
export function commandOf(rawInput: unknown): string | undefined {
  const i = asObj(rawInput);
  for (const key of ['command', 'cmd', 'script', 'shell_command', 'shellCommand']) {
    const v = i[key];
    if (typeof v === 'string' && v.trim()) return v;
    if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return (v as string[]).map(shellQuote).join(' ');
  }
  return undefined;
}

const PATH_KEYS = ['file_path', 'filePath', 'path', 'absolute_path', 'notebook_path', 'target_file', 'destination', 'source', 'old_path', 'new_path'];

export function pathsOf(tc: AcpToolCall, cwd: string): string[] {
  const out: string[] = [];
  const add = (p: unknown) => { const s = str(p); if (s) out.push(path.resolve(cwd, s)); };
  for (const l of tc.locations ?? []) add(l?.path);
  for (const c of tc.content ?? []) if (c?.type === 'diff') add(c.path);
  const i = asObj(tc.rawInput);
  for (const k of PATH_KEYS) add(i[k]);
  if (Array.isArray(i.paths)) i.paths.forEach(add);
  return [...new Set(out)];
}

const WRITE_HINT = ['content', 'new_string', 'newString', 'newText', 'old_string', 'oldString', 'diff', 'patch', 'edits'];

export function intentFor(tc: AcpToolCall, cwd: string): ToolIntent {
  const tool = tc.name ?? tc.title ?? tc.kind ?? 'tool';
  const input = asObj(tc.rawInput);
  const base = { tool: short(tool, 80) };
  // Whatever carries a command line is judged as a command, whatever the agent calls it.
  let cmd = commandOf(tc.rawInput);
  if (!cmd && tc.kind === 'execute') cmd = str(tc.title)?.replace(/^`+|`+$/g, '').trim() || undefined;
  if (cmd) return { ...base, class: 'exec', rawCommand: cmd, summary: short(str(input.description) ?? cmd) };

  const paths = pathsOf(tc, cwd);
  const diffs = (tc.content ?? []).some((c) => c?.type === 'diff');
  const writes = tc.kind === 'edit' || tc.kind === 'delete' || tc.kind === 'move' || diffs || (paths.length > 0 && WRITE_HINT.some((k) => k in input));
  if (writes) return { ...base, class: 'write', paths, summary: short(`${tc.kind ?? 'edit'} ${paths[0] ?? tc.title ?? ''}`.trim()) };
  if (tc.kind === 'read' || tc.kind === 'search') return { ...base, class: 'read', paths, summary: short(`${tc.kind} ${paths[0] ?? str(input.pattern) ?? tc.title ?? ''}`.trim()) };
  if (tc.kind === 'fetch') {
    const url = str(input.url) ?? str(input.uri);
    return { ...base, class: 'net', ...(url ? { url } : {}), summary: short(`fetch ${url ?? tc.title ?? ''}`.trim()) };
  }
  const m = /^mcp__(.+?)__(.+)$/.exec(tc.name ?? '');
  if (m) return { ...base, class: 'mcp', server: m[1], summary: `${m[1]}: ${m[2]}` };
  // An unknown tool's card shows what it would do: a redacted, truncated copy of its input. Class other -> ask (fail closed).
  let body = '';
  try { body = tc.rawInput === undefined ? '' : (JSON.stringify(tc.rawInput) ?? ''); } catch { /* unserializable */ }
  return { ...base, class: 'other', summary: short(`${tc.title ?? tool} ${redact(body)}`.trim(), 200) };
}

/** Intent of one of OUR handlers (fs/terminal), where the call arrives with exact arguments. */
export const execIntent = (command: string, args: string[] | undefined, tool: string): ToolIntent => {
  const rawCommand = args?.length ? [command, ...args].map(shellQuote).join(' ') : command;
  return { class: 'exec', tool, rawCommand, summary: short(rawCommand) };
};
