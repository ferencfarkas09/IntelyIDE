import type { McpPolicy, McpServerView, McpToolView, McpTransport, McpVarView } from "../mcp";

/*
 * What the MCP mock keeps per server and how it turns a record into the view of the spec ((design notes: mcp-management-spec) 2.2, 3.1): the
 * fingerprint, the confirmation hash, the display escapes, the state. A secret value is never kept, only whether its slot has one.
 */

export interface McpVarRec {
  name: string;
  secret: boolean;
  value?: string;
  present: boolean;
}

export interface ToolRec {
  name: string;
  key: string;
  description: string;
  readOnlyHint: boolean | null;
  destructiveHint: boolean | null;
}

export interface ServerRec {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  env: McpVarRec[];
  headers: McpVarRec[];
  enabled: boolean;
  defaultPolicy: McpPolicy;
  toolPolicies: { tool: string; policy: McpPolicy; seeded?: boolean }[];
  tools: ToolRec[];
  toolsTestedAt: number | null;
  toolsFingerprint: string | null;
  serverInfo: { name: string; version: string; protocolVersion: string } | null;
  imported: boolean;
  confirmedHash: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The tools of the spec's fixture server (9.1) as a Test learns them. */
export const FIXTURE_TOOLS: ToolRec[] = [
  { name: "echo", key: "echo", description: "Returns its input unchanged.", readOnlyHint: true, destructiveHint: null },
  { name: "write_note", key: "write_note", description: "Writes a note to the server's own notebook.", readOnlyHint: false, destructiveHint: null },
  { name: "mystery", key: "mystery", description: "Does something the server does not describe.", readOnlyHint: null, destructiveHint: null },
  { name: "git_commit", key: "git_commit", description: "Commits the staged changes of a repository.", readOnlyHint: false, destructiveHint: null },
];

export const SECRET_NAME = /key|token|secret|password|passwd|auth/i;
export const EXEC_VAR = /^(PATH|HOME|SHELL|NODE_OPTIONS|BASH_ENV|PYTHONPATH|HTTPS?_PROXY|npm_config_.*)$/i;
const BLOCKED_KEYS = /(^|[_-])(deploy|deployment|publish|wrangler|rollout)([_-]|$)|^git[_-].*(commit|push|add|reset|rebase|merge|tag|stash|checkout)|^(push_files|create_or_update_file|delete_file|merge_pull_request|create_branch|delete_branch|create_release|force_push)$/;

export const blockedByDefault = (key: string, destructive: boolean | null): boolean => destructive === true || BLOCKED_KEYS.test(key.toLowerCase());

/** One short stable hash, repeated to the 64 hex characters of the real fingerprint: enough to tell two records apart. */
export function hash64(text: string): string {
  let out = "";
  for (let seed = 0; seed < 8; seed++) {
    let h = 0x811c9dc5 ^ seed;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}

/** The display form of the spec: every non-printable or non-ASCII character as `\u{..}`, padding spaces as U+2423. */
export function show(text: string): string {
  const escaped = [...text]
    .map((c) => {
      const cp = c.codePointAt(0)!;
      return cp >= 0x20 && cp < 0x7f ? c : `\\u{${cp.toString(16)}}`;
    })
    .join("");
  return escaped.replace(/^ +| +$| {2,}/g, (run) => "␣".repeat(run.length));
}

const quoteForLine = (arg: string) => (/[\s'"]/.test(arg) ? `'${show(arg).replace(/'/g, "'\\''")}'` : show(arg));
const isRunner = (command: string) => /(^|\/)(npx|bunx|pnpx|uvx)$/.test(command);
/** `pkg@1.2.3` and `pkg==1.2.3` are pinned; `@latest`, a range and no suffix are not. */
const pinned = (pkg: string) => /^(@[^/@]+\/)?[^@=]+(@|==)\d+(\.\d+){1,2}([-+][\w.-]+)?$/.test(pkg);

export const fingerprint = (s: ServerRec): string => hash64([s.transport, s.command ?? "", ...s.args, s.url ?? ""].join("\0"));

export function codeFiles(s: ServerRec): { path: string; sha256: string }[] {
  if (s.transport !== "stdio") return [];
  return [s.command ?? "", ...s.args].filter((p) => p.startsWith("/")).map((path) => ({ path: show(path), sha256: hash64(path).slice(0, 12) }));
}

export function confirmHash(s: ServerRec): string {
  const vars = (list: McpVarRec[], tag: string) => list.map((v) => `${tag}:${v.name}:${v.secret ? "S" : `P=${v.value ?? ""}`}`).sort().join("\0");
  return hash64([fingerprint(s), vars(s.env, "env"), vars(s.headers, "hdr"), codeFiles(s).map((f) => `code:${f.path}:${f.sha256}`).join("\0")].join("\0"));
}

export function stateOf(s: ServerRec): McpServerView["state"] {
  if (confirmHash(s) !== s.confirmedHash) return "needsConfirm";
  if ([...s.env, ...s.headers].some((v) => v.secret && !v.present)) return "secretMissing";
  return "ready";
}

export function fetchesCode(s: ServerRec): boolean {
  if (s.transport !== "stdio" || !isRunner(s.command ?? "")) return false;
  const pkg = s.args.find((a) => !a.startsWith("-"));
  return !pkg || !pinned(pkg);
}

export function toolViews(s: ServerRec): McpToolView[] {
  const stale = s.toolsTestedAt !== null && s.toolsFingerprint !== fingerprint(s);
  return s.tools.map((tool) => {
    const own = s.toolPolicies.find((p) => p.tool === tool.key);
    return {
      name: tool.name,
      key: tool.key,
      description: tool.description,
      readOnly: !stale && tool.readOnlyHint === true,
      readOnlyHint: tool.readOnlyHint,
      destructiveHint: tool.destructiveHint,
      policy: own?.policy ?? null,
      effectivePolicy: own?.policy ?? s.defaultPolicy,
      blockedByDefault: blockedByDefault(tool.key, tool.destructiveHint),
      seeded: own?.seeded === true,
    };
  });
}

export function serverView(s: ServerRec): McpServerView {
  const stale = s.toolsTestedAt !== null && s.toolsFingerprint !== fingerprint(s);
  const listed = new Set(s.tools.map((t) => t.key));
  const varView = (v: McpVarRec): McpVarView => (v.secret ? { name: v.name, secret: true, present: v.present } : { name: v.name, secret: false, value: v.value ?? "", present: true });
  const host = s.url ? (/^https?:\/\/([^/:?#]+)/i.exec(s.url)?.[1] ?? "") : undefined;
  return {
    id: s.id,
    name: s.name,
    transport: s.transport,
    ...(s.command !== undefined ? { command: s.command } : {}),
    args: [...s.args],
    ...(s.url !== undefined ? { url: s.url } : {}),
    env: s.env.map(varView),
    headers: s.headers.map(varView),
    enabled: s.enabled,
    defaultPolicy: s.defaultPolicy,
    tools: toolViews(s),
    toolsTestedAt: s.toolsTestedAt,
    toolsStale: stale,
    staleToolPolicies: s.toolPolicies.filter((p) => !listed.has(p.tool)).map((p) => ({ tool: p.tool, policy: p.policy })),
    serverInfo: s.serverInfo ? { ...s.serverInfo } : null,
    state: stateOf(s),
    confirmed: confirmHash(s) === s.confirmedHash,
    imported: s.imported,
    confirmHash: confirmHash(s),
    ...(s.transport === "stdio" ? { commandLine: [s.command ?? "", ...s.args].map(quoteForLine).join(" ") } : {}),
    argsDisplay: s.args.map(show),
    ...(host !== undefined ? { urlHost: host } : {}),
    codeFiles: codeFiles(s),
    fetchesCode: fetchesCode(s),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}
