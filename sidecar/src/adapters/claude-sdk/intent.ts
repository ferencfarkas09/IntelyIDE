// Claude tool name -> ToolClass/ToolKind/ToolIntent (providers-plan 5.4). Adapters only classify; Rust parses and decides.
import type { Actor, ToolIntent, ToolKind } from '../../types.js';
import { redact } from '../../redact.js';
import { PEER_SEND_TOOL, PEER_SERVER } from './peer-tools.js';

/** The full name of the peer tool that sends a message to another run of the same person (see peer-tools.ts). */
const PEER_SEND_FULL = `mcp__${PEER_SERVER}__${PEER_SEND_TOOL}`;

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
    // A workflow (ultracode runs only): one that asks to run off this machine carries `remote`, which the broker refuses.
    case 'Workflow':
    {
      const check = workflowCheck(input);
      return { ...base, class: 'other', ...(check ? { workflowCheck: check } : {}), summary: `Workflow ${short(str(input.name) ?? str(input.scriptPath) ?? '', 80)}`.trim() };
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
        // The IDE's own peer tools: the broker needs the target run, and only that, to ask once per pair. It travels in `argv`, which the
        // card keeps. `args` carries a redacted copy of the text for the host's card excerpt only: the host never serialises it into an event or the log.
        if (tool === PEER_SEND_FULL) return { ...base, class: 'mcp', server, argv: [str(input.run_id) ?? ''], ...({ args: [redact(str(input.text) ?? '').slice(0, 2000)] } as object), summary: `${PEER_SERVER}: ${PEER_SEND_TOOL}` };
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

/** The keys of a `Workflow` input that may be present: the inline script and its `args` (`description` and `title` are ignored by the CLI). */
export const WORKFLOW_KEYS = ["script", "args", "description", "title"];
/** Words that ask for another place to run: a hard stop anywhere in a workflow script, as `isolation` is for `Agent`. */
export const WORKFLOW_ISOLATION_WORDS = ["isolation", "worktree", "remote"];
/** Code that builds keys, strings or code at run time (searched with the whitespace removed, case kept). */
export const WORKFLOW_EVASION = ["]:", "eval(", "Function(", "\\u", "\\x", "fromCharCode", "fromCodePoint", "JSON.parse", "Object.assign", "Reflect.", "defineProperty", "import(", "require("];
/** Keys that would pick what the run's own choice already set (searched with the whitespace removed, lower case). */
export const WORKFLOW_OVERRIDES = ["model:", "effort:", "agenttype:"];
const CONCAT = ["'+'", '"+"', "'+\"", "\"+'", "`+`", "'+`", "`+'", '"+`', '`+"'];

/**
 * What the broker refuses about a `Workflow` input, or undefined: the same rules as `workflow_check` in Rust (a best-effort TEXT check of a
 * program; every tool call of the workflow's helper agents is judged by the broker on its own).
 */
export function workflowCheck(input: Record<string, unknown>): { kind: string; detail: string } | undefined {
  const extra = Object.keys(input).filter((k) => !WORKFLOW_KEYS.includes(k) && input[k] !== null && input[k] !== undefined).sort();
  if (extra.length) return { kind: "input", detail: extra[0]! };
  const script = typeof input.script === "string" ? input.script : "";
  if (!script.trim()) return { kind: "input", detail: "script" };
  const lower = script.toLowerCase();
  const word = WORKFLOW_ISOLATION_WORDS.find((w) => lower.includes(w));
  if (word) return { kind: "isolation", detail: word };
  const squeezed = script.replace(/\s/g, "");
  const ev = WORKFLOW_EVASION.find((e) => squeezed.includes(e));
  if (ev) return { kind: "evasion", detail: ev };
  if (CONCAT.some((p) => squeezed.includes(p))) return { kind: "evasion", detail: "string concatenation" };
  const low = squeezed.toLowerCase();
  const ov = WORKFLOW_OVERRIDES.find((o) => low.includes(o));
  return ov ? { kind: "override", detail: ov } : undefined;
}
