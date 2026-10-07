import type { PermissionMode } from "@intely/protocol";
import type { MessageKey } from "../../i18n";
import type { McpList, McpPolicy, McpPolicyPatch, McpRunServer, McpServerView, McpState, McpToolView, McpUnavailable, McpWorkspaceState } from "../../ipc/mcp";
import execVars from "./exec-vars.json";

/*
 * The pure part of the MCP screens: validation mirrors for early feedback (Rust, `crates/mcp/src/model.rs`, stays the authority and
 * answers with the same stable codes), the display escape of the confirm dialog, tool ordering, the policy patches of the table and the
 * rules of the run picker. Nothing here touches a secret value or the IPC.
 */

// ---------------------------------------------------------------------------------------------------------------- names

export const NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED_NAMES: ReadonlySet<string> = new Set(["mcp", "agent", "task"]);

/** Spec 2.3: the prefix of the tool names agents see. `others` are the names of the other servers (unique case-insensitively). */
export function nameProblem(name: string, others: readonly string[] = []): "mcpBadName" | "mcpNameTaken" | null {
  if (!NAME_RE.test(name) || /^(claude|intely)/.test(name) || RESERVED_NAMES.has(name)) return "mcpBadName";
  return others.some((o) => o.toLowerCase() === name.toLowerCase()) ? "mcpNameTaken" : null;
}

/** Same words as `name_looks_secret` in `crates/settings/src/secrets.rs`: a lowercase substring match. */
const SECRET_WORDS = ["key", "token", "secret", "password", "passwd", "auth"] as const;
export const isSecretName = (name: string): boolean => {
  const n = name.toLowerCase();
  return SECRET_WORDS.some((w) => n.includes(w));
};

const EXEC_EXACT: ReadonlySet<string> = new Set(execVars.exact);
const EXEC_ANY_CASE: ReadonlySet<string> = new Set(execVars.anyCase);
/** Names that make a program run other code, load a library or fetch from another host (spec 2.4): refused for secret and plain values. */
export const isExecVar = (name: string): boolean =>
  EXEC_EXACT.has(name) || EXEC_ANY_CASE.has(name.toUpperCase()) || execVars.prefixAnyCase.some((p) => name.toLowerCase().startsWith(p));

/** Every name of the table, for the shared-fixture test. */
export const EXEC_VAR_TABLE = execVars;

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const REFUSED_HEADERS: ReadonlySet<string> = new Set(["host", "content-length", "content-type", "accept", "mcp-session-id", "mcp-protocol-version", "transfer-encoding", "connection"]);

/** `mcpBadVar` for a shape or a refused name, `mcpExecVar` for the exec-affecting list (environment only). Empty names are not judged yet. */
export function varNameProblem(kind: "env" | "header", name: string): "mcpBadVar" | "mcpExecVar" | null {
  if (!name) return null;
  if (kind === "header") return !HEADER_NAME_RE.test(name) || REFUSED_HEADERS.has(name.toLowerCase()) ? "mcpBadVar" : null;
  if (!ENV_NAME_RE.test(name) || execVars.refusedPrefixes.some((p) => name.startsWith(p))) return "mcpBadVar";
  return isExecVar(name) ? "mcpExecVar" : null;
}

// --------------------------------------------------------------------------------------------------- characters, paths, url

/** C0, DEL, C1, the bidirectional controls and the zero-width and invisible format characters (spec 2.4 "Characters"). */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/;
export const hasForbiddenChars = (text: string): boolean => FORBIDDEN_CHARS.test(text);

/** A relative path runs whatever the agent put in the run's directory: only `/...` or a bare program name is accepted (spec 2.4). */
const isRelativePath = (text: string): boolean => text.startsWith("~") || text.startsWith("./") || text.startsWith("../");

export function commandProblem(command: string): "mcpBadCommand" | "mcpRelativePath" | "mcpBadChars" | null {
  const c = command.trim();
  if (!c || c.length > 1024) return "mcpBadCommand";
  if (hasForbiddenChars(c)) return "mcpBadChars";
  return isRelativePath(c) || (c.includes("/") && !c.startsWith("/")) ? "mcpRelativePath" : null;
}

export function argsProblem(args: readonly string[]): "mcpTooMany" | "mcpBadChars" | "mcpRelativePath" | null {
  if (args.length > 64) return "mcpTooMany";
  if (args.some((a) => a.length > 4096 || hasForbiddenChars(a))) return "mcpBadChars";
  return args.some(isRelativePath) ? "mcpRelativePath" : null;
}

const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])([:/?#]|$)/;

export function urlProblem(url: string): "mcpBadUrl" | "mcpBadChars" | null {
  const u = url.trim();
  if (!u || u.length > 2048) return "mcpBadUrl";
  if (hasForbiddenChars(u)) return "mcpBadChars";
  // eslint-disable-next-line no-control-regex
  if (/[^\u0000-\u007f]/.test(u) || /\s/.test(u) || u.includes("#")) return "mcpBadUrl";
  if (!(u.startsWith("https://") || LOOPBACK.test(u))) return "mcpBadUrl";
  const authority = u.replace(/^https?:\/\//, "").split(/[/?#]/)[0] ?? "";
  return authority.includes("@") || !authority ? "mcpBadUrl" : null;
}

/** One argument per line: no quoting rules to learn. Blank lines are dropped, a trailing carriage return never belongs to an argument. */
export const argsFromText = (text: string): string[] => text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.length > 0);
export const argsToText = (args: readonly string[]): string => args.join("\n");

/** The display form of the spec (7.4): every non-printable or non-ASCII character as `\u{..}`, padding and doubled spaces as U+2423. */
export function escapeForDisplay(text: string): string {
  const escaped = Array.from(text, (c) => {
    const cp = c.codePointAt(0)!;
    return cp >= 0x20 && cp < 0x7f ? c : `\\u{${cp.toString(16)}}`;
  }).join("");
  return escaped.replace(/^ +| +$| {2,}/g, (run) => "␣".repeat(run.length));
}

// -------------------------------------------------------------------------------------------------------------- tools

export type ToolMark = "reads" | "writes" | "unknown";

/** What the server SAYS about a tool (`readOnlyHint`): an untrusted claim, worded that way. */
export const toolMark = (tool: Pick<McpToolView, "readOnlyHint">): ToolMark => (tool.readOnlyHint === true ? "reads" : tool.readOnlyHint === false ? "writes" : "unknown");

const MARK_RANK: Record<ToolMark, number> = { writes: 0, unknown: 1, reads: 2 };

/** Tools the server marks as changing things first, then the not stated, then the read-only; by name inside a group. */
export const orderTools = (tools: readonly McpToolView[]): McpToolView[] =>
  [...tools].sort((a, b) => MARK_RANK[toolMark(a)] - MARK_RANK[toolMark(b)] || a.name.localeCompare(b.name));

export const filterTools = (tools: readonly McpToolView[], query: string): McpToolView[] => {
  const q = query.trim().toLowerCase();
  return q ? tools.filter((t) => t.name.toLowerCase().includes(q) || (t.description ?? "").toLowerCase().includes(q)) : [...tools];
};

export const POLICIES: readonly McpPolicy[] = ["ask", "allow", "deny"];

/** The rule of the pseudo-tool `resources` (the CLI's two resource tools, spec 5.4 step 1): carried as a tool entry or as a rule of an unlisted tool. */
export const RESOURCES_TOOL = "resources";
export function resourcesRule(server: Pick<McpServerView, "tools" | "staleToolPolicies">): McpPolicy | null {
  return server.tools.find((t) => t.key === RESOURCES_TOOL)?.policy ?? server.staleToolPolicies.find((p) => p.tool === RESOURCES_TOOL)?.policy ?? null;
}

/** Rules for tools the last Test did not list, without the resources rule (it has its own row). */
export const staleRules = (server: Pick<McpServerView, "staleToolPolicies">) => server.staleToolPolicies.filter((p) => p.tool !== RESOURCES_TOOL);

/** The choice of a Rule select: `inherit` removes the override. */
export type RuleChoice = McpPolicy | "inherit";

/** Whether a change takes a tool that is denied because it looks like a commit, push or deploy to something that runs (spec 7.6). */
export function loosensBlocked(tool: Pick<McpToolView, "blockedByDefault" | "effectivePolicy">, choice: RuleChoice, defaultPolicy: McpPolicy): boolean {
  return tool.blockedByDefault && tool.effectivePolicy === "deny" && (choice === "inherit" ? defaultPolicy : choice) !== "deny";
}

/** "Allow all read-only tools": skips every tool the Test blocked by default, and is meaningless while the marks are stale. */
export function allowReadOnlyPatch(server: Pick<McpServerView, "tools" | "toolsStale">): McpPolicyPatch | null {
  if (server.toolsStale) return null;
  const tools = server.tools.filter((t) => t.readOnly && !t.blockedByDefault && t.policy !== "allow").map((t) => ({ tool: t.key, policy: "allow" as const }));
  return tools.length ? { tools } : null;
}

/** "Reset rules": removes only the user's own overrides; the seeded ones are the product's default, not the user's rule. */
export function resetRulesPatch(server: Pick<McpServerView, "tools" | "staleToolPolicies">): McpPolicyPatch | null {
  const own = server.tools.filter((t) => t.policy !== null && !t.seeded && t.key !== RESOURCES_TOOL).map((t) => ({ tool: t.key, policy: null }));
  const resources = resourcesRule(server) !== null && !server.tools.some((t) => t.key === RESOURCES_TOOL && t.seeded) ? [{ tool: RESOURCES_TOOL, policy: null }] : [];
  const tools = [...own, ...resources];
  return tools.length ? { tools } : null;
}

// -------------------------------------------------------------------------------------------------------------- rows

export type StateTone = "ok" | "warn" | "danger" | "neutral";

/** Never tested = neutral: a server that was never started has no state worth a colour. */
export function stateTone(server: Pick<McpServerView, "state" | "toolsTestedAt">): StateTone {
  switch (server.state) {
    case "ready":
      return server.toolsTestedAt === null ? "neutral" : "ok";
    case "needsConfirm":
    case "secretMissing":
      return "warn";
    default:
      return "danger";
  }
}

export const STATE_KEY: Record<McpState, MessageKey> = {
  ready: "mcp.state.ready",
  needsConfirm: "mcp.state.needsConfirm",
  secretMissing: "mcp.state.secretMissing",
  invalid: "mcp.state.invalid",
  unsupported: "mcp.state.unsupported",
};

export const POLICY_KEY: Record<McpPolicy, MessageKey> = { ask: "mcp.policy.ask", allow: "mcp.policy.allow", deny: "mcp.policy.deny" };

/** A server that was tested must have been confirmed (a Test needs the proof): tested but unconfirmed now means it changed since. */
export const changedSinceConfirm = (server: Pick<McpServerView, "confirmed" | "toolsTestedAt">): boolean => !server.confirmed && server.toolsTestedAt !== null;

/** The effective state of one workspace for one server: `inherit` when it has no override. */
export const workspaceState = (list: Pick<McpList, "workspace">, serverId: string): McpWorkspaceState => list.workspace.overrides.find((o) => o.serverId === serverId)?.state ?? "inherit";

// ------------------------------------------------------------------------------------------------------------- errors

/** The stable codes the editor can show next to a field (spec 2.4, 3.2): each has an `mcp.err.<code>` key in en and hu. */
export const EDITOR_CODES = [
  "mcpBadName", "mcpNameTaken", "mcpBadCommand", "mcpSecretInArgs", "mcpBadUrl", "mcpSecretInUrl", "mcpBadVar", "mcpExecVar", "mcpPlainSecretName",
  "mcpBadSecret", "mcpTooMany", "mcpRelativePath", "mcpBadChars", "mcpCodeTooBig", "mcpBlockedByDefault", "reservedNamespace", "readOnly", "unsupportedVersion", "keychain",
] as const;

/** The codes of a Test (spec 4.7) plus the OAuth wording of `mcpAuth`: each has an `mcp.test.code.<code>` key. */
export const TEST_CODES = [
  "mcpSpawnFailed", "mcpTimeout", "mcpExited", "mcpProtocol", "mcpAuth", "mcpAuthOauth", "mcpHttpStatus", "mcpTls", "mcpConnect", "mcpBusy", "readOnly", "testJail",
  "confirmationRequired", "mcpSecretMissing", "keychain",
] as const;

/** The supplier codes a start can fail with because of the selected servers (spec 3.2, 8.2): each has an `mcp.runerr.<code>` key. */
export const RUN_CODES = ["confirmationRequired", "mcpSecretMissing", "mcpAuthModeUnsupported", "mcpUnavailable", "mcpCodeInRunDir", "mcpCodeTooBig"] as const;

const inList = (list: readonly string[], code: string) => list.includes(code);

export const editorErrorKey = (code: string): MessageKey => (inList(EDITOR_CODES, code) ? (`mcp.err.${code}` as MessageKey) : "mcp.err.generic");

export function testErrorKey(error: { code: string; detail?: string }): MessageKey {
  if (error.code === "mcpAuth" && error.detail === "oauth") return "mcp.test.code.mcpAuthOauth";
  return inList(TEST_CODES, error.code) ? (`mcp.test.code.${error.code}` as MessageKey) : "mcp.test.code.generic";
}

/** For the New run dialog's error line (ui-modes imports it): any other code uses the generic text with the message. */
export const mcpRunErrorKey = (code: string): MessageKey => (inList(RUN_CODES, code) ? (`mcp.runerr.${code}` as MessageKey) : "mcp.runerr.generic");

export type EditorField = "name" | "command" | "args" | "url" | "vars" | "form";

/** Where the editor shows the answer of a code: under the field it is about, or at the foot of the form. */
export function errorField(code: string): EditorField {
  switch (code) {
    case "mcpBadName":
    case "mcpNameTaken":
      return "name";
    case "mcpBadCommand":
    case "mcpRelativePath":
    case "mcpCodeTooBig":
      return "command";
    case "mcpSecretInArgs":
      return "args";
    case "mcpBadUrl":
    case "mcpSecretInUrl":
      return "url";
    case "mcpBadVar":
    case "mcpExecVar":
    case "mcpPlainSecretName":
    case "mcpBadSecret":
      return "vars";
    default:
      return "form";
  }
}

export interface ErrorInfo {
  code: string;
  message: string;
  detail?: string;
}

/** What a rejected command carries (an `EngineError`), tolerant of anything else that can be thrown. */
export function errorInfo(e: unknown): ErrorInfo {
  if (typeof e === "object" && e !== null && typeof (e as ErrorInfo).code === "string") {
    const { code, message, detail } = e as ErrorInfo;
    return { code, message: typeof message === "string" ? message : "", ...(typeof detail === "string" ? { detail } : {}) };
  }
  return { code: "unknown", message: e instanceof Error ? e.message : String(e) };
}

// -------------------------------------------------------------------------------------------------------------- picker

/** MCP exists for Claude and the mock provider only (D9, spec 1): every other adapter keeps `mcp: {}` and the picker renders nothing. */
export const mcpProviderSupported = (provider: string): boolean => provider === "claude" || provider === "mock";

/** What to put in the start request: nothing for a provider without MCP, else the ids once (the picker drops unavailable ones itself). */
export const mcpStartIds = (value: readonly string[], provider: string): string[] => (mcpProviderSupported(provider) ? [...new Set(value)] : []);

/** The workspace default of the picker: the servers that are on by default there and can start. */
export const mcpDefaultSelection = (servers: readonly McpRunServer[]): string[] => servers.filter((s) => s.defaultOn && s.available).map((s) => s.id);

/** Keeps only the selected ids that still name an available server. */
export const pruneSelection = (value: readonly string[], servers: readonly McpRunServer[]): string[] => value.filter((id) => servers.some((s) => s.id === id && s.available));

export const UNAVAILABLE_KEY: Record<McpUnavailable, MessageKey> = {
  needsConfirm: "mcp.picker.unavailable.needsConfirm",
  secretMissing: "mcp.picker.unavailable.secretMissing",
  invalid: "mcp.picker.unavailable.invalid",
  unsupportedProvider: "mcp.picker.unavailable.unsupportedProvider",
  unsupportedAuth: "mcp.picker.unavailable.unsupportedAuth",
  readOnlyJail: "mcp.picker.unavailable.readOnlyJail",
  unsupported: "mcp.picker.unavailable.unsupported",
};

/** The reasons that Settings can fix: the chip offers "Open settings". */
export const fixableInSettings = (reason: McpUnavailable | undefined): boolean => reason === "needsConfirm" || reason === "secretMissing" || reason === "invalid";

export interface PickerWarnings {
  /** The one-line mode note, only while a chip is selected. */
  mode: "automatic" | "bypass" | "plan" | null;
  /** Selected servers that keep a secret in their environment (Automatic and Bypass only, spec 6.4 point 3). */
  secretEnv: string[];
  /** Tools that change things and would run without asking, with the servers that own them (Automatic and Bypass only). */
  exposure: { count: number; names: string[] } | null;
}

export function pickerWarnings(mode: PermissionMode, selected: readonly McpRunServer[]): PickerWarnings {
  if (!selected.length) return { mode: null, secretEnv: [], exposure: null };
  const unattended = mode === "automatic" || mode === "bypass";
  const exposed = unattended ? selected.filter((s) => s.exposedCount > 0) : [];
  return {
    mode: mode === "automatic" || mode === "bypass" ? mode : mode === "readOnly" ? "plan" : null,
    secretEnv: unattended ? selected.filter((s) => s.hasSecretEnv).map((s) => s.name) : [],
    exposure: exposed.length ? { count: exposed.reduce((n, s) => n + s.exposedCount, 0), names: exposed.map((s) => s.name) } : null,
  };
}

/** The optimistic effect of a policy patch on a server draft (inside `produce`); the answer of `mcp_set_policy` replaces it. */
export function applyPolicyPatch(server: McpServerView, patch: McpPolicyPatch): void {
  if (patch.defaultPolicy) {
    server.defaultPolicy = patch.defaultPolicy;
    for (const tool of server.tools) if (tool.policy === null) tool.effectivePolicy = patch.defaultPolicy;
  }
  for (const change of patch.tools ?? []) {
    const tool = server.tools.find((x) => x.key === change.tool);
    if (tool) {
      tool.policy = change.policy;
      tool.effectivePolicy = change.policy ?? server.defaultPolicy;
      tool.seeded = false;
    } else {
      server.staleToolPolicies = server.staleToolPolicies.filter((p) => p.tool !== change.tool);
      if (change.policy !== null) server.staleToolPolicies.push({ tool: change.tool, policy: change.policy });
    }
  }
}
