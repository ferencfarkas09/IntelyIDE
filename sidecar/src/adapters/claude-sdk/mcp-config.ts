// Keeps MCP server secrets off the command line ((design notes: mcp-management-spec) 5.5). The Agent SDK turns the `mcpServers` option into ONE argv
// element, `--mcp-config <JSON text>`, and the arguments of a process are readable by the same user with `ps` (and by the agent through its
// Bash tool wherever the mode lets it run `ps`). The environment and header values of a server are secrets, so the JSON is moved into a 0600
// file inside a fresh 0700 directory and the argv carries the FILE PATH instead.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface McpConfigFile {
  /** The argv with the file path in place of the JSON; unchanged (a copy) when there was nothing to move. */
  args: string[];
  /** Removes the file and its directory. Idempotent. */
  cleanup(): void;
  /** The `intely-mcp-<rand>` directory, when one was created. */
  dir?: string;
}

const FLAG = '--mcp-config';

/** A JSON text that names at least one server (an empty set needs no file: there is nothing to protect). Unparseable text counts as content. */
function namesServers(json: string): boolean {
  try {
    const v: unknown = JSON.parse(json);
    const servers = typeof v === 'object' && v !== null ? (v as { mcpServers?: unknown }).mcpServers : undefined;
    return typeof servers === 'object' && servers !== null && Object.keys(servers).length > 0;
  } catch {
    return true;
  }
}

/**
 * Moves the value of `--mcp-config` into a 0600 file in a fresh 0700 temporary directory (`intely-mcp-<rand>`) and returns the argv with the
 * path instead. No `--mcp-config`, a value that is not JSON text (already a path) or an empty server set: `args` unchanged and a no-op cleanup.
 * A failure to write the file THROWS (fail closed: the session does not start, and the JSON is never left on the command line).
 */
export function moveMcpConfigToFile(args: readonly string[]): McpConfigFile {
  const unchanged: McpConfigFile = { args: [...args], cleanup() {} };
  const at = args.findIndex((a) => a === FLAG || a.startsWith(`${FLAG}=`));
  if (at < 0) return unchanged;
  const inline = args[at]!.startsWith(`${FLAG}=`);
  const json = inline ? args[at]!.slice(FLAG.length + 1) : args[at + 1];
  if (json === undefined || !json.trimStart().startsWith('{') || !namesServers(json)) return unchanged;

  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'intely-mcp-')); // mode 0700
    const file = join(dir, 'mcp.json');
    writeFileSync(file, json, { mode: 0o600, flag: 'wx' });
    const next = [...args];
    if (inline) next[at] = `${FLAG}=${file}`;
    else next[at + 1] = file;
    const made = dir;
    let done = false;
    return {
      args: next,
      dir: made,
      cleanup() {
        if (done) return;
        done = true;
        rmSync(made, { recursive: true, force: true });
      },
    };
  } catch (e) {
    if (dir) rmSync(dir, { recursive: true, force: true });
    // the message carries the error code only: never a path of the config, never its content
    throw new Error(`cannot write the MCP config file (${(e as NodeJS.ErrnoException).code ?? 'error'}); the session is not started`);
  }
}
