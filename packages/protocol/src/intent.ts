// Mirror of ToolIntent::from_claude_tool (crates/agent_core/src/policy/intent.rs): adapters map a Claude tool name
// and raw input to a class and pass it on; Rust parses and decides. Parity is tested against fixtures/intent-cases.json.
import type { ToolIntent } from "./generated/policy";

type Input = Record<string, unknown>;

const text = (input: Input, key: string): string | undefined => (typeof input[key] === "string" ? (input[key] as string) : undefined);

function shorten(raw: string): string {
  const lines = raw.split("\n").map((l) => l.replace(/\r$/, ""));
  if (lines.at(-1) === "") lines.pop();
  const line = lines[0] ?? "";
  const chars = Array.from(line);
  const out = chars.slice(0, 160).join("");
  return chars.length > 160 || lines.length > 1 ? `${out}…` : out;
}

export function intentFromClaudeTool(name: string, input: Input = {}): ToolIntent {
  switch (name) {
    case "Bash": {
      const command = text(input, "command");
      return { class: "exec", tool: name, rawCommand: command, summary: shorten(command ?? "") };
    }
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit": {
      const paths = ["file_path", "notebook_path"].flatMap((k) => text(input, k) ?? []);
      return { class: "write", tool: name, paths, summary: `${name.toLowerCase()} ${paths.join(", ")}` };
    }
    case "Read":
    case "Grep":
    case "Glob":
    case "LS": {
      const paths = ["file_path", "path"].flatMap((k) => text(input, k) ?? []);
      const pattern = text(input, "pattern");
      // An absolute glob pattern reads outside the cwd even without a `path`.
      if (name === "Glob" && pattern && (pattern.startsWith("/") || pattern.startsWith("~"))) {
        paths.push(pattern.split(/[*?[{]/)[0] ?? "");
      }
      return { class: "read", tool: name, paths, summary: `${name.toLowerCase()} ${paths.join(", ")}` };
    }
    case "WebFetch":
    case "WebSearch": {
      const url = text(input, "url");
      return { class: "net", tool: name, url, summary: `${name} ${url ?? text(input, "query") ?? ""}` };
    }
    case "Task":
    case "Agent": {
      const subagentType = text(input, "subagent_type");
      const isolation = text(input, "isolation");
      const background = typeof input.run_in_background === "boolean" ? input.run_in_background : undefined;
      return {
        class: "other",
        tool: name,
        subagentType,
        ...(isolation !== undefined ? { isolation } : {}),
        subagentFlags: {
          hasModel: input.model !== undefined && input.model !== null,
          ...(background !== undefined ? { background } : {}),
          ...(subagentType !== undefined ? { subagentType } : {}),
        },
        summary: name,
      };
    }
    case "Workflow":
      // judged by the broker only when ultracode is on; one that asks to run off this machine carries `remote`
    {
      const check = workflowCheck(input);
      return { class: "other", tool: name, ...(check ? { workflowCheck: check } : {}), summary: name };
    }
    default: {
      // Anything named `mcp__...` is an MCP call, also a malformed one (`mcp__`, `mcp____x`, `mcp__a__`): the same split as the
      // Rust mapping, which hands it to the broker (denied there as `mcp.unknown`) instead of the unknown-tool row.
      if (name.startsWith("mcp__")) {
        const rest = name.slice(5);
        const split = rest.indexOf("__");
        const server = split >= 0 ? rest.slice(0, split) : rest;
        const tool = split >= 0 ? rest.slice(split + 2) : "";
        return { class: "mcp", tool: name, server, summary: `${server}.${tool}` };
      }
      // Monitor and any other tool that runs a shell string are judged like Bash.
      const command = text(input, "command");
      if (command !== undefined) return { class: "exec", tool: name, rawCommand: command, summary: shorten(command) };
      return { class: "other", tool: name, summary: name };
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
