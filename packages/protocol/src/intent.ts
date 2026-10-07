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
