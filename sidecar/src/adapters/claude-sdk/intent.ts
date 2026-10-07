// Claude tool name -> ToolClass/ToolKind/ToolIntent (providers-plan 5.4). Adapters only classify; Rust parses and decides.
import type { Actor, ToolIntent, ToolKind } from '../../types.js';
import { redact } from '../../redact.js';

type In = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const asIn = (v: unknown): In => (v && typeof v === 'object' ? (v as In) : {});

export function toolKind(name: string): ToolKind {
  switch (name) {
    case 'Read': case 'LS': return 'read';
    case 'Grep': case 'Glob': return 'search';
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': return 'edit';
    case 'Bash': case 'BashOutput': case 'KillShell': case 'Monitor': return 'exec';
    case 'WebFetch': case 'WebSearch': return 'fetch';
    case 'TodoWrite': return 'think';
    default: return name.startsWith('mcp__') ? 'mcp' : 'other';
  }
}

const safeJson = (v: unknown): string => { try { return v === undefined ? '' : (JSON.stringify(v) ?? ''); } catch { return ''; } };
const short = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n)}...` : s);

/** `actor` = who made the call (a sub-agent); absent for the lead. It comes from the harness (hook input), never from the tool input. */
export function intentFor(tool: string, rawInput: unknown, parentToolId?: string, actor?: Actor): ToolIntent {
  const input = asIn(rawInput);
  const base = { tool, ...(parentToolId ? { parentToolId } : {}), ...(actor ? { actor } : {}) };
  switch (tool) {
    case 'Bash': {
      const cmd = str(input.command) ?? '';
      return { ...base, class: 'exec', rawCommand: cmd, summary: str(input.description) ?? short(cmd) };
    }
    case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': {
      const p = str(input.file_path) ?? str(input.notebook_path);
      return { ...base, class: 'write', paths: p ? [p] : [], summary: `${tool} ${p ?? ''}`.trim() };
    }
    case 'Read': case 'LS': case 'Grep': case 'Glob': {
      // Same paths the Rust mapping (ToolIntent::from_claude_tool) yields; the golden test compares them.
      const paths = [str(input.file_path), str(input.path)].filter((p): p is string => !!p);
      const what = str(input.pattern) ?? '';
      // An absolute glob pattern reads outside the cwd even without a `path`.
      if (tool === 'Glob' && (what.startsWith('/') || what.startsWith('~'))) paths.push(what.split(/[*?[{]/)[0] ?? '');
      return { ...base, class: 'read', paths, summary: `${tool} ${paths[0] ?? what}`.trim() };
    }
    case 'WebFetch': {
      const url = str(input.url);
      return { ...base, class: 'net', ...(url ? { url } : {}), summary: `WebFetch ${url ?? ''}`.trim() };
    }
    case 'WebSearch':
      return { ...base, class: 'net', summary: `WebSearch ${short(str(input.query) ?? '', 80)}`.trim() };
    case 'Agent': case 'Task': {
      const sub = str(input.subagent_type);
      const isolation = str(input.isolation);
      const background = typeof input.run_in_background === 'boolean' ? input.run_in_background : undefined;
      return {
        ...base, class: 'other', ...(sub ? { subagentType: sub } : {}), ...(isolation ? { isolation } : {}),
        // the facts the broker judges (it never sees the input): same shape as ToolIntent::from_claude_tool
        subagentFlags: { hasModel: input.model !== undefined && input.model !== null, ...(background !== undefined ? { background } : {}), ...(sub ? { subagentType: sub } : {}) },
        summary: `Subagent ${sub ?? ''} ${short(str(input.description) ?? '', 80)}`.trim(),
      };
    }
    // The plan itself travels in the permission.request `plan` field, never in the intent (the Remote record shrinks the summary).
    case 'ExitPlanMode':
      return { ...base, class: 'other', summary: 'ExitPlanMode: leave plan mode' };
    default: {
      // Anything named `mcp__...` is an MCP call, also a malformed one (`mcp__`, `mcp____x`, `mcp__a__`): the same split as the Rust mapping,
      // which hands it to the broker (denied there as `mcp.unknown`) instead of the unknown-tool row.
      if (tool.startsWith('mcp__')) {
        const rest = tool.slice('mcp__'.length);
        const cut = rest.indexOf('__');
        const server = cut < 0 ? rest : rest.slice(0, cut);
        return { ...base, class: 'mcp', server, summary: `${server}: ${cut < 0 ? '' : rest.slice(cut + 2)}`.trim() };
      }
      // Monitor and any other tool that runs a shell string go through the same command analysis as Bash.
      const cmd = str(input.command);
      if (cmd) return { ...base, class: 'exec', rawCommand: cmd, summary: str(input.description) ?? short(cmd) };
      // An unknown tool's card must show what it would do: a redacted, truncated copy of its input.
      return { ...base, class: 'other', summary: `${tool} ${short(redact(safeJson(rawInput)), 200)}`.trim() };
    }
  }
}
