// Codex item / approval request -> ToolKind and ToolIntent (providers-plan 5.4). Adapters only classify; Rust parses and decides.
import path from 'node:path';
import { redact } from '../../redact.js';
import type { ToolIntent, ToolKind } from '../../types.js';
import { isObj, type Json, str } from './wire.js';

const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}...` : s);

/** commandExecution -> read / search when every parsed action is one, else exec. */
export function commandKind(item: Json): ToolKind {
  const actions = Array.isArray(item.commandActions) ? item.commandActions.filter(isObj) : [];
  if (!actions.length) return 'exec';
  if (actions.every((a) => a.type === 'read')) return 'read';
  if (actions.every((a) => a.type === 'read' || a.type === 'listFiles' || a.type === 'search')) return 'search';
  return 'exec';
}

export function itemKind(item: Json): { name: string; kind: ToolKind } | undefined {
  switch (item.type) {
    case 'commandExecution': return { name: 'shell', kind: commandKind(item) };
    case 'fileChange': {
      const changes: Json[] = Array.isArray(item.changes) ? item.changes.filter(isObj) : [];
      return { name: 'apply_patch', kind: changes.length && changes.every((c) => c.kind?.type === 'delete') ? 'delete' : 'edit' };
    }
    case 'mcpToolCall': return { name: `mcp__${String(item.server ?? 'server')}__${String(item.tool ?? 'tool')}`, kind: 'mcp' };
    case 'webSearch': return { name: 'web_search', kind: 'fetch' };
    case 'dynamicToolCall': return { name: String(item.tool ?? 'dynamic_tool'), kind: 'other' };
    case 'collabAgentToolCall': return { name: `agent.${String(item.tool ?? 'call')}`, kind: 'other' };
    case 'imageView': return { name: 'view_image', kind: 'read' };
    case 'imageGeneration': return { name: 'image_gen', kind: 'other' };
    default: return undefined;
  }
}

export const abs = (cwd: string, p: string): string => (path.isAbsolute(p) ? path.normalize(p) : path.resolve(cwd, p));

/** Every path a fileChange touches (including the target of a move), absolute. */
export function changedPaths(cwd: string, changes: unknown): string[] {
  const out: string[] = [];
  for (const c of Array.isArray(changes) ? changes : []) {
    if (!isObj(c)) continue;
    const p = str(c.path);
    if (p) out.push(abs(cwd, p));
    const mv = str(c.kind?.move_path);
    if (mv) out.push(abs(cwd, mv));
  }
  return out;
}

export function commandIntent(command: string, reason?: string): ToolIntent {
  const why = reason ? ` (${short(redact(reason), 80)})` : '';
  return { class: 'exec', tool: 'shell', rawCommand: command, summary: `${short(command)}${why}` };
}

export function argvIntent(argv: string[], reason?: string): ToolIntent {
  const line = argv.join(' ');
  return { class: 'exec', tool: 'shell', argv, summary: `${short(line)}${reason ? ` (${short(redact(reason), 80)})` : ''}` };
}

export function fileIntent(paths: string[], reason?: string): ToolIntent {
  return { class: 'write', tool: 'apply_patch', paths, summary: `apply_patch ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` +${paths.length - 3}` : ''}${reason ? ` (${short(redact(reason), 80)})` : ''}`.trim() };
}

export function networkIntent(host: string, protocol: string): ToolIntent {
  return { class: 'net', tool: 'shell', url: `${protocol}://${host}`, summary: `network ${protocol}://${host}` };
}

export function otherIntent(tool: string, summary: string): ToolIntent {
  return { class: 'other', tool, summary: short(redact(summary), 200) };
}
