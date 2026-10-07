// Init-facts assertion (generalized "init-assert", providers-plan 2.2/4.2): compare what the CLI reports in system/init
// (model, permission mode, plugins, MCP servers, hook events, credential) with what the role asked for.
// Pure functions, no I/O. Messages are short human-readable strings that the run card shows as an amber chip.
import type { AuthFact, AuthMode, PermissionMode, ResolvedRole } from '../../types.js';
import type { Raw } from './map.js';

/** The slice of initializationResult().models[] we use (SDK ModelInfo). */
export interface CliModel {
  value: string;
  resolvedModel?: string;
  displayName?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

/** The Claude CLI mode that realises an IDE mode (spec 6.1, spike table). Automatic and Bypass both run as `acceptEdits`: Rust (the policy) says allow, the CLI keeps its boundary prompts as a second layer. Never `bypassPermissions`, `dontAsk` or `auto`. */
export function permissionModeFor(p: PermissionMode): 'plan' | 'acceptEdits' | 'default' {
  switch (p) {
    case 'readOnly': return 'plan';
    case 'ask': return 'default';
    case 'edit': case 'automatic': case 'bypass': return 'acceptEdits';
    default: throw new Error(`permission "${String(p)}" is not offered for Claude (the SDK modes bypassPermissions, dontAsk and auto are never used)`);
  }
}

export { isUnattended, isWriterMode } from '../../abstract.js';

const norm = (s: string) => s.toLowerCase();
const same = (a: string, b: string) => norm(a) === norm(b) || norm(a).startsWith(norm(b)) || norm(b).startsWith(norm(a));

/** Finds the catalog entry for a model id or alias as the role wrote it or as init reports it. */
export function findModel(models: CliModel[], ...names: (string | undefined)[]): CliModel | undefined {
  for (const n of names) {
    if (!n) continue;
    const hit = models.find((m) => m.value === n || m.resolvedModel === n) ?? models.find((m) => m.resolvedModel && same(m.resolvedModel, n));
    if (hit) return hit;
  }
  return undefined;
}

export function modelMatches(requested: string, actual: string, models: CliModel[]): boolean {
  if (same(requested, actual)) return true;
  const a = findModel(models, requested);
  return !!a && ((!!a.resolvedModel && same(a.resolvedModel, actual)) || same(a.value, actual));
}

/** Subscription login reports "none"; any key-like source means API billing. */
export function checkCredential(mode: AuthMode, source: string, strayKeyRemoved: boolean): AuthFact {
  const keyed = !['none', 'oauth'].includes(source);
  let warning: string | undefined;
  if (mode === 'subscription' && keyed) warning = `subscription session is using credential "${source}" (API billing); expected the login`;
  else if (mode === 'apiKey' && source !== 'ANTHROPIC_API_KEY') warning = `API-key session reports credential "${source}" instead of ANTHROPIC_API_KEY`;
  else if (mode === 'subscription' && strayKeyRemoved) warning = 'ANTHROPIC_API_KEY was set in the host environment and was removed for this subscription session';
  return { mode, source, ...(warning ? { warning } : {}) };
}

export interface FactInputs {
  init: Raw;
  role: ResolvedRole;
  /** The IDE mode the session holds NOW (it changes live); defaults to the role's. */
  mode?: PermissionMode;
  mcpExpected: string[];
  models: CliModel[];
  appliedEffort: string | null;
  /** Hook events seen from anything but our own SDK hook. */
  foreignHookEvents: number;
  /** Names of the delegates passed in `agents`; `undefined` = the classic session, which is not checked. */
  delegateNames?: string[];
  /** Settings sources the session loads; agents of those sources may legitimately show up in `init.agents`. */
  settingSources?: string[];
}

/** Agent types the CLI always has (they are not ours and not a leak). */
export const BUILTIN_AGENT_TYPES = ['general-purpose', 'Explore', 'Plan', 'statusline-setup'];

/** Oldest CLI the delegation path was checked against ((design notes: roles-orchestration-spec) 4.4, D12); mirrors MIN_CLI_FOR_DELEGATION in crates/agent_host. */
export const MIN_CLI_FOR_DELEGATION = '2.1.284';

/**
 * The fail-closed form of the isolation check: a user plugin (its PreToolUse hooks can hold gigabytes and can refuse tools) or a
 * foreign MCP server in the init report means the session is NOT isolated from the user's Claude setup. Returns the reason or null.
 * Built-in plugins (`path: "builtin"`) are the CLI's own and fine.
 */
export function isolationLeak(init: Raw, mcpExpected: readonly string[]): string | null {
  const plugins = (Array.isArray(init.plugins) ? init.plugins : []).filter((p: Raw) => p?.path !== 'builtin').map((p: Raw) => String(p?.name ?? '?'));
  const allowed = new Set(mcpExpected);
  const mcp = (Array.isArray(init.mcp_servers) ? init.mcp_servers : []).map((s: Raw) => String(s?.name)).filter((n: string) => !allowed.has(n));
  if (!plugins.length && !mcp.length) return null;
  return `settings isolation leaked: user plugin(s) [${plugins.join(', ')}]${mcp.length ? ` and MCP server(s) [${mcp.join(', ')}]` : ''} were loaded into the agent session`;
}

/** The wire states of an MCP server; the CLI says `needs-auth`, the wire says `needsAuth`. Anything unknown counts as `pending`. */
export type McpState = 'connected' | 'failed' | 'pending' | 'needsAuth' | 'disabled';

export function mcpState(s: unknown): McpState {
  switch (s) {
    case 'connected': case 'failed': case 'pending': case 'disabled': return s;
    case 'needs-auth': case 'needsAuth': return 'needsAuth';
    default: return 'pending';
  }
}

const MAX_SLASH_COMMANDS = 300;
const MAX_ERROR = 300;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/**
 * What the run's header and composer need from `system/init`: the CLI's slash commands (names, no leading slash) and the MCP servers
 * with their state, an error text (passed through `scrub`) and the number of tools the init `tools` list holds for them. Never the
 * server configuration. Both lists are bounded.
 */
export function initSessionInfo(init: Raw, scrub: (s: string) => string): { slashCommands: string[]; mcpServers: { name: string; status: McpState; error?: string; tools?: number }[] } {
  const cmds = new Set<string>();
  for (const c of Array.isArray(init.slash_commands) ? init.slash_commands : []) {
    const name = typeof c === 'string' ? c.replace(/^\//, '').trim() : '';
    if (name && !/\s/.test(name)) cmds.add(name);
    if (cmds.size >= MAX_SLASH_COMMANDS) break;
  }
  const tools: string[] = Array.isArray(init.tools) ? init.tools.filter((t: unknown): t is string => typeof t === 'string') : [];
  const mcpServers = (Array.isArray(init.mcp_servers) ? init.mcp_servers : [])
    .filter((s: Raw) => typeof s?.name === 'string' && s.name)
    .map((s: Raw) => {
      const name = String(s.name);
      const count = tools.filter((t) => t.startsWith(`mcp__${name}__`)).length;
      return {
        name,
        status: mcpState(s.status),
        ...(typeof s.error === 'string' && s.error ? { error: scrub(clip(s.error, MAX_ERROR)) } : {}),
        ...(count > 0 ? { tools: count } : {}),
      };
    });
  return { slashCommands: [...cmds], mcpServers };
}

export function assertInit(i: FactInputs): string[] {
  const bad: string[] = [];
  const { init, role } = i;
  if (!modelMatches(role.model, String(init.model), i.models)) bad.push(`model: role asks "${role.model}", CLI runs "${init.model}"`);
  const want = permissionModeFor(i.mode ?? role.permission);
  if (init.permissionMode !== want) bad.push(`permission mode: expected "${want}", CLI reports "${init.permissionMode}"`);
  const entry = findModel(i.models, role.model, String(init.model));
  const levels = entry?.supportedEffortLevels ?? [];
  if (role.effort) {
    if (levels.length === 0 && i.appliedEffort !== null) bad.push(`effort: model has no effort control but "${i.appliedEffort}" is applied`);
    else if (levels.includes(role.effort) && i.appliedEffort !== role.effort) bad.push(`effort: role asks "${role.effort}", applied "${i.appliedEffort}"`);
  }
  const foreign = (Array.isArray(init.plugins) ? init.plugins : []).filter((p: Raw) => p?.path !== 'builtin');
  if (foreign.length) bad.push(`plugins: ${foreign.length} non-builtin plugin(s) loaded`);
  const got = (Array.isArray(init.mcp_servers) ? init.mcp_servers : []).map((s: Raw) => String(s.name)).sort();
  const want2 = [...i.mcpExpected].sort();
  if (got.join('\n') !== want2.join('\n')) bad.push(`mcp servers: expected [${want2.length}], CLI reports [${got.length}]`);
  for (const s of Array.isArray(init.mcp_servers) ? init.mcp_servers : []) if (s?.status === 'failed') bad.push(`mcp server "${s.name}" failed to start`);
  if (i.delegateNames) {
    // two-sided: every delegate must be known to the CLI, and nothing but the built-ins and the delegates may be there
    const known = new Set<string>(Array.isArray(init.agents) ? init.agents.map(String) : []);
    for (const n of i.delegateNames) if (!known.has(n)) bad.push(`agents: role ${n} not known to the CLI`);
    if ((i.settingSources ?? []).length === 0) {
      const allowed = new Set([...BUILTIN_AGENT_TYPES, ...i.delegateNames]);
      for (const n of known) if (!allowed.has(n)) bad.push(`agents: agent ${n} leaked despite settingSources: []`);
    }
  }
  if (i.foreignHookEvents > 0) bad.push(`hooks: ${i.foreignHookEvents} hook event(s) from outside the IDE (settings isolation leaked)`);
  return bad;
}
