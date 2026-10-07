import type { McpPolicy } from "@intely/protocol";
import { call } from "./rpc";

/*
 * MCP server management ((design notes: mcp-management-spec) 3). The Rust structs of `crates/mcp` are the source of these shapes; until
 * `pnpm bindings` writes `ui/src/bindings/mcp.ts` they are carried here by hand, with the names of spec 3.1 and 3.2, so the swap
 * to the generated types is a re-export. A secret value only ever goes in (`McpVarInput.secretValue`): no view carries one.
 */

export type { McpPolicy };
export type McpTransport = "stdio" | "http";
export type McpWorkspaceState = "inherit" | "on" | "off";
/** Why a server cannot be tested or started right now (the first applicable one). */
export type McpState = "ready" | "needsConfirm" | "secretMissing" | "invalid" | "unsupported";

export interface McpVarView {
  name: string;
  secret: boolean;
  /** Plain variables only. */
  value?: string;
  /** Secret: an item exists in the Keychain; plain: always true. */
  present: boolean;
}

export interface McpToolView {
  name: string;
  key: string;
  title?: string;
  description?: string;
  /** `readOnlyHint === true` of a fresh list: what the policy engine uses. */
  readOnly: boolean;
  /** The raw annotation: `true` reads only, `false` changes things, `null` not stated. */
  readOnlyHint: boolean | null;
  destructiveHint: boolean | null;
  /** The override the user set (or the Test seeded); `null` = the server default applies. */
  policy: McpPolicy | null;
  effectivePolicy: McpPolicy;
  collision?: boolean;
  /** The key or the destructive hint matches the git/deploy write vocabulary (spec 4.4). */
  blockedByDefault: boolean;
  /** The current override is the Test's seed, not the user's choice. */
  seeded: boolean;
}

export interface McpServerView {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  env: McpVarView[];
  headers: McpVarView[];
  enabled: boolean;
  defaultPolicy: McpPolicy;
  tools: McpToolView[];
  toolsTestedAt: number | null;
  toolsStale: boolean;
  /** Overrides for tools the last Test did not list. */
  staleToolPolicies: { tool: string; policy: McpPolicy }[];
  serverInfo: { name: string; version: string; protocolVersion: string } | null;
  state: McpState;
  /** The Keychain proof equals `confirmHash`. */
  confirmed: boolean;
  /** Origin is an import: the confirm dialog adds a warning line about hidden values. */
  imported: boolean;
  /** What the user must send to `mcp_confirm`; the dialog shows exactly what it covers. */
  confirmHash: string;
  /** Command and arguments on ONE line, escaped, never run through a shell. */
  commandLine?: string;
  /** The confirm dialog's form: one entry per argument, escaped, never truncated. */
  argsDisplay: string[];
  /** http: the host as stored (ASCII, punycode form). */
  urlHost?: string;
  /** stdio: the files the proof vouches for; `sha256` is the first 12 hex characters. */
  codeFiles: { path: string; sha256: string }[];
  /** An unpinned package runner: the code is fetched at every start. */
  fetchesCode: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface McpList {
  schema: number;
  servers: McpServerView[];
  workspace: { id: string | null; overrides: { serverId: string; state: "on" | "off" }[] };
  secrets: { backend: "keychain" | "memory"; degraded: boolean; message: string | null };
  jail: "off" | "readOnly" | "e2e";
  readOnlyReason?: "newerSchema";
  problems: { index: number; reason: string }[];
}

export interface McpVarInput {
  name: string;
  secret: boolean;
  /** Plain variables only. */
  value?: string;
  /** WRITE-ONLY. Present = set or replace the Keychain item; absent on an existing secret slot = keep it. */
  secretValue?: string;
}

export interface McpSaveInput {
  id?: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  env?: McpVarInput[];
  headers?: McpVarInput[];
  enabled: boolean;
}

export interface McpPolicyPatch {
  defaultPolicy?: McpPolicy;
  /** `policy: null` removes an override. `acknowledgeBlocked` is set only after the warning dialog of spec 7.6. */
  tools?: { tool: string; policy: McpPolicy | null; acknowledgeBlocked?: boolean }[];
}

export interface McpTestError {
  code: string;
  message: string;
  detail?: string;
}

export interface McpTestReport {
  ok: boolean;
  ms: number;
  protocolVersion?: string;
  serverInfo?: { name: string; version: string };
  capabilities?: { tools: boolean; resources: boolean; prompts: boolean };
  tools: McpToolView[];
  toolCount: number;
  truncated: boolean;
  newTools: string[];
  removedTools: string[];
  blockedByDefault: string[];
  fetchesCode: boolean;
  instructions?: string;
  instructionsChanged?: boolean;
  stderrTail?: string;
  error?: McpTestError;
}

/** The closed set of reasons an import entry has trouble (spec 3.3). */
export type McpImportIssue = "unsupportedTransport" | "badName" | "nameTaken" | "secretInArgs" | "secretInUrl" | "unresolvedRef" | "badCommand" | "badVar" | "badChars" | "relativePath" | "tooMany";

export interface McpImportEntry {
  /** The original name in the file. */
  key: string;
  suggestedName: string;
  transport: McpTransport | "unknown";
  commandLine?: string;
  urlHost?: string;
  /** NAMES ONLY, never values. */
  env: { name: string; secret: boolean }[];
  headers: { name: string; secret: boolean }[];
  issues: McpImportIssue[];
  importable: boolean;
  conflict: boolean;
}

export interface McpImportPreview {
  importId: string;
  /** Basename only. */
  fileName: string;
  entries: McpImportEntry[];
  /** Top-level keys that were not objects. */
  skippedKeys: number;
  expiresAt: number;
}

export interface McpImportPick {
  key: string;
  name: string;
  /** Overwrite the server of the same name. */
  replace: boolean;
}

export interface McpImportResult {
  imported: { key: string; id: string }[];
  skipped: { key: string; reason: string }[];
}

export interface McpSecretPresence {
  serverId: string;
  slot: string;
  present: boolean;
}

export type McpUnavailable = "needsConfirm" | "secretMissing" | "invalid" | "unsupportedProvider" | "unsupportedAuth" | "readOnlyJail" | "unsupported";

/** One entry of the New run dialog's server picker (spec 7.7): never a secret, never a command line. */
export interface McpRunServer {
  id: string;
  name: string;
  transport: McpTransport;
  /** The effective default for the workspace (spec 2.5). */
  defaultOn: boolean;
  available: boolean;
  unavailable?: McpUnavailable;
  toolCount: number;
  readOnlyCount: number;
  defaultPolicy: McpPolicy;
  /** The default or any tool is deny. */
  hasDenied: boolean;
  /** A stdio server with at least one secret environment slot (Automatic and Bypass warn about it). */
  hasSecretEnv: boolean;
  /** Listed tools that are neither read-only nor deny: they run without a prompt in Automatic and Bypass. */
  exposedCount: number;
}

export interface McpIpc {
  /** `workspaceId` is the active workspace's registry id; without it the overrides are not applied. */
  list(workspaceId?: string | null): Promise<McpList>;
  /** Create (no `id`) or replace (`id`). Validates in Rust; the rejection carries a stable `mcp*` code. */
  save(input: McpSaveInput): Promise<McpServerView>;
  /** `index:<n>` removes an entry of `McpList.problems`. */
  remove(id: string): Promise<void>;
  /** Switching on needs a confirmed record (`confirmationRequired`); switching off never does. */
  setEnabled(id: string, enabled: boolean): Promise<McpServerView>;
  /** Only succeeds when `confirmHash` equals the recomputed hash: a dialog cannot confirm text the user did not see. */
  confirm(id: string, confirmHash: string): Promise<McpServerView>;
  workspaceSet(workspaceId: string, serverId: string, state: McpWorkspaceState): Promise<McpList>;
  setPolicy(id: string, patch: McpPolicyPatch): Promise<McpServerView>;
  /** Spawns (stdio, killed afterwards) or connects (http), reads `tools/list`, persists the learned tools. Requires a confirmed record. */
  test(id: string, timeoutMs?: number): Promise<McpTestReport>;
  /** `token` is a single-use picker token of the purpose `file:mcpImport`. */
  importPreview(token: string): Promise<McpImportPreview>;
  importApply(importId: string, picks: McpImportPick[]): Promise<McpImportResult>;
  secretsPresent(ids?: string[]): Promise<McpSecretPresence[]>;
  /** The data of the run picker. */
  runServers(workspaceId: string | null | undefined, provider: string): Promise<McpRunServer[]>;
}

export function createTauriMcp(): McpIpc {
  return {
    list: (workspaceId) => call("mcp_list", workspaceId ? { workspaceId } : {}),
    save: (input) => call("mcp_save", { input }),
    remove: (id) => call("mcp_remove", { id }),
    setEnabled: (id, enabled) => call("mcp_set_enabled", { id, enabled }),
    confirm: (id, confirmHash) => call("mcp_confirm", { id, confirmHash }),
    workspaceSet: (workspaceId, serverId, state) => call("mcp_workspace_set", { workspaceId, serverId, state }),
    setPolicy: (id, patch) => call("mcp_set_policy", { id, patch }),
    test: (id, timeoutMs) => call("mcp_test", { id, ...(timeoutMs ? { timeoutMs } : {}) }),
    importPreview: (token) => call("mcp_import_preview", { token }),
    importApply: (importId, picks) => call("mcp_import_apply", { importId, picks }),
    secretsPresent: (ids) => call("mcp_secrets_present", ids ? { ids } : {}),
    runServers: (workspaceId, provider) => call("mcp_run_servers", { ...(workspaceId ? { workspaceId } : {}), provider }),
  };
}
