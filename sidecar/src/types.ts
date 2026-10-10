// Sidecar-local interfaces ((design notes: providers-plan) 1.2) on top of the generated wire types of @intely/protocol
// (crates/agent_core is the single source: `pnpm protocol:gen`). Only what has no Rust counterpart lives here:
// the adapter interface, the request/reply map of the NDJSON protocol client and the event input type.
import type {
  AuthMode,
  BatchEvent,
  Detection,
  EventKind,
  ModelInfo,
  PermissionMode,
  PermissionOutcome,
  PolicyDecision as ProtoPolicyDecision,
  PolicyRequest,
  ProviderCaps,
  DelegateSpec,
  McpServerStatus,
  McpToggle,
  SessionAllowOffer,
  SessionStart,
  SessionEnv as ProtoSessionEnv,
  SettingSource,
  StopReason,
} from '@intely/protocol';

export type {
  Actor,
  AgentEvent,
  AuthFact,
  AuthMode,
  Cap,
  CapEntry,
  CostBasis,
  DecidedBy,
  DelegateInfo,
  DelegateScope,
  DelegateSpec,
  Detection,
  Effort,
  ErrorClass,
  ModelInfo,
  ModelTokens,
  PermissionMode,
  PermissionOption,
  PermissionOutcome,
  PolicyRequest,
  ProviderCaps,
  QuestionOption,
  StatusState,
  StopReason,
  TokenCounts as UsageTotals,
  ToolClass,
  ToolIntent,
  ToolKind,
  ToolStatus,
  UsageRecord,
} from '@intely/protocol';

import type { NoteErrorCode } from './abstract.js';

export type ProviderId = string;

/** `reason`, `rule` and `sessionAllow` are optional on the wire; the sidecar needs decision and by, and offers allow_run when `sessionAllow` is present. */
export type PolicyDecision = Omit<ProtoPolicyDecision, 'reason' | 'rule' | 'sessionAllow'> & { reason?: string; rule?: string | null; sessionAllow?: SessionAllowOffer | null };

/** What an adapter hands to the sink: the sink adds agentId, provider, seq and ts. */
export type EventInput = EventKind & { turnId?: string | null; raw?: unknown };
/** What travels inside events/batch (agentId and provider are batch-level). */
export type WireEvent = BatchEvent;

export interface EventSink { emit(e: EventInput): void }

export interface PolicyClient { decide(req: PolicyRequest): Promise<PolicyDecision> }

// ---------- interface (1.2) ----------
export type ResolvedRole = {
  name: string;
  model: string;
  effort?: string | null;
  /** The run mode (abstract, 2.2). Refused by non-Claude adapters when `automatic` or `bypass`. */
  permission: PermissionMode;
  systemPrompt?: string | null;
  tools?: string[];
  disallowedTools?: string[];
  maxTurns?: number | null;
  maxBudgetUsd?: number | null;
};

export interface McpSet { [server: string]: Record<string, unknown> }

/** The env block of session/start (5.5). Rust supplies the paths; the sidecar scrubs `vars` again. */
export type SessionEnv = Omit<ProtoSessionEnv, 'claudeBin' | 'shimDir' | 'vars'> & {
  /** Installed claude CLI, passed as pathToClaudeCodeExecutable. */
  claudeBin?: string | null;
  /** Allow-list git shim directory, put first in PATH. */
  shimDir?: string | null;
  /** Base environment of the child; when absent the sidecar's own environment is used (then scrubbed). */
  vars?: Record<string, string> | null;
};

export interface SessionSpec {
  agentId: string;
  provider: ProviderId;
  role: ResolvedRole;
  cwd: string;
  addDirs: string[];
  resume?: { nativeId: string };
  /** Pre-assigned native session id for a new session (Claude). */
  sessionId?: string;
  env: SessionEnv;
  mcp: McpSet;
  auth: { mode: AuthMode; key: string | null };
  /** Mock adapter only. */
  mock?: { scenario?: string; script?: string; speed?: number };
  /** ACP adapters only (CONTRACT-CHANGE Beta2-Q1): the launch line and the proof state; see adapters/acp. */
  acp?: AcpLaunch;
  /** Claude settings sources to load; default [] (isolated). The enforcement suite uses ['project','local'] to prove the layers beat a permissive settings.local.json. */
  settingSources?: SettingSource[];
  /** Ablation switch for the enforcement suite (3.1: a layer counts only if its ablation run passes). Default true; Rust never sets it in production. */
  denyRules?: boolean;
  /** The roles an Auto lead may hand work to (Claude and the mock adapter). Absent = the classic single-role session. */
  delegates?: DelegateSpec[];
  /** Where the CLI keeps its plan notes (an absolute path; Claude only). Absent = the CLI default (never in production). */
  planDir?: string;
  /** `false` = leave the user's own ~/.claude/CLAUDE.md out of the prompt (Claude only). Absent = on. */
  includeUserMemory?: boolean;
}

/** An attachment as the Rust host resolves it for a prompt: metadata plus the absolute path of the stored copy. */
export type PromptAttachment = { id: string; name: string; mime: string; size: number; kind: 'image' | 'text' | 'pdf' | 'file'; sha256: string; inline?: boolean; path: string };

export type UserInput = { text: string; attachments?: PromptAttachment[] };

export interface PermissionAnswer {
  /** 'allow' | 'deny' | 'cancelled'. allow_once and allow_run both arrive as 'allow': the session scope lives in the host. */
  outcome: PermissionOutcome;
  /** Deny feedback; for an ExitPlanMode rejection this is the user's text, returned verbatim to the model. */
  message?: string;
  /** AskUserQuestion: question text -> chosen label. */
  answers?: Record<string, string>;
  /** ExitPlanMode approval: the continuation mode, always present when the host forwards an approval. */
  mode?: PermissionMode;
}

/** session/start.acp: a user-confirmed command line for the generic ACP provider, or overrides for a profile (gemini). */
export interface AcpLaunch {
  command?: string;
  args?: string[];
  /** Extra variables for the agent process (after the scrub). */
  env?: Record<string, string>;
  /** Rust sets this only when the computed enforcement chip of (adapter, authMode, role mode, cliVersion) allows a write role; absent = readOnly roles only. */
  writeAllowed?: boolean;
  /** Test/timing overrides in ms: initialize/session setup timeout, SIGTERM->SIGKILL grace. */
  initTimeoutMs?: number;
  termMs?: number;
}

/** Cancel deadlines the host runs on (cancel/request): an adapter that escalates by itself finishes before them. */
export interface InterruptOpts { softMs?: number; termMs?: number }

/** `session/mcp-status`: optionally reconnect or toggle one server first. */
export type McpStatusOp = { reconnect?: string; toggle?: McpToggle };
export type McpStatusServer = McpServerStatus;

/** A note the user adds to a running agent (`session/note`): delivered to `parentToolId`'s sub-agent, or the lead when absent, at its next tool call. */
export type SessionNote = { noteId: string; text: string; parentToolId?: string | null };

export interface AgentSession {
  readonly nativeId: string;
  prompt(input: UserInput): void;
  interrupt(opts?: InterruptOpts): Promise<void>;
  setModel?(id: string): Promise<void>;
  setEffort?(level: string): Promise<void>;
  setPermission?(mode: PermissionMode): Promise<void>;
  /** Live MCP status of the session (Claude only). */
  mcpStatus?(op?: McpStatusOp): Promise<McpStatusServer[]>;
  /** Queues a note for the lead or one sub-agent and reports it (`note` events); throws `NoteError` when it cannot be delivered. Claude and the mock adapter only. */
  note?(n: SessionNote): void;
  answer(reqId: string, answer: PermissionAnswer): void;
  close(): Promise<void>;
}

/** Services the host gives an adapter besides sink and policy. */
export interface HostServices {
  /** Registers a spawned child so Rust can kill its process group if the sidecar dies (5.6). */
  registerPid(pid: number): void;
}

export interface DetectContext { claudeBin?: string }

export interface AgentProvider {
  readonly id: ProviderId;
  readonly kind: 'sdk' | 'acp' | 'cli' | 'api';
  detect(ctx: DetectContext): Promise<Detection>;
  capabilities(ctx: DetectContext, auth?: AuthMode): ProviderCaps;
  listModels(ctx: DetectContext, auth?: AuthMode): Promise<ModelInfo[]>;
  open(spec: SessionSpec, sink: EventSink, policy: PolicyClient, host: HostServices): Promise<AgentSession>;
}

// ---------- sidecar <-> Rust (5.5) ----------
export interface Envelope<T extends string = string, B = unknown> { v: 1; id: number; type: T; body: B }

export type SlotError = 'noSlot' | 'rssBudget' | 'writeLease';
/** session/start body as the sidecar reads it: the generated shape with nulls allowed to be absent. */
export type SessionStartBody = Omit<SessionStart, 'role' | 'env' | 'auth' | 'mock'> & {
  role: ResolvedRole;
  env: SessionEnv;
  auth: { mode: AuthMode; key: string | null };
  mock?: SessionSpec['mock'];
  acp?: AcpLaunch;
};

export interface SidecarMsg {
  hello: { body: { pid: number; version: string; node: string; providers: string[] } };
  heartbeat: { body: { pid: number; loaded: string[]; sessions: number } };
  'policy/decide': { body: PolicyRequest; reply: PolicyDecision };
  'slot/acquire': {
    body: { agentId: string; provider: ProviderId; writer: boolean; repoId?: string; ttlMs: number };
    reply: { leaseId: string; ttlMs: number; treeBudgetMb?: number } | { error: SlotError; detail?: string };
  };
  'slot/renew': { body: { leaseId: string; pgids: number[]; rssHintMb?: number }; reply: { ok: true } | { error: string } };
  'slot/release': { body: { leaseId: string }; reply: { ok: true } };
  'events/batch': { body: { agentId: string; provider: ProviderId; events: WireEvent[] } };
  'session/start': {
    body: SessionStartBody;
    reply: { ok: true; nativeId: string } | { error: string; detail?: string };
  };
  'session/prompt': { body: { agentId: string; text: string; attachments?: PromptAttachment[] }; reply: { ok: true } | { error: string } };
  'cancel/request': { body: { agentId: string; softMs: number; termMs: number }; reply: { ok: true } };
  'cancel/done': { body: { agentId: string; stopReason: StopReason; ms: number } };
  'permission/answer': { body: { agentId: string; reqId: string } & PermissionAnswer; reply: { ok: true } };
  'session/close': { body: { agentId: string }; reply: { ok: true } };
  /** Live permission-mode switch (Claude and the mock adapter); `rejected` = the CLI refused it, `timeout` = no answer in 5 s. */
  'session/permission': { body: { agentId: string; mode: PermissionMode }; reply: { ok: true } | { error: 'noSession' | 'unsupported' | 'rejected' | 'timeout'; detail?: string } };
  /** Live MCP status of a session (Claude): the servers with their state and tools. */
  'session/mcp-status': { body: { agentId: string; reconnect?: string; toggle?: McpToggle }; reply: { ok: true; servers: McpStatusServer[] } | { error: 'noSession' | 'unsupported' | 'failed'; detail?: string } };
  /** A note for the lead (no `parentToolId`) or the running sub-agent started by that `Agent`/`Task` call; delivered at its next tool call. */
  'session/note': { body: { agentId: string; noteId: string; text: string; parentToolId?: string | null }; reply: { ok: true } | { error: 'noSession' | 'unsupported' | NoteErrorCode; detail?: string } };
  /** The plan limits of the signed-in Claude account (limits.ts): no open session needed. */
  'usage/limits': { body: import('./limits.js').LimitsRequest; reply: import('./limits.js').LimitsReply };
  /** File-system questions of the permission broker about THIS machine (fsquery.ts); a read-only oracle, sent ad hoc by the host (not in the generated Rust enum). */
  'fs/query': { body: { ops: import('./fsquery.js').FsOp[] }; reply: import('./fsquery.js').FsQueryReply };
  // session history (history.ts): no open session needed
  'history/list': { body: { dir?: string; limit?: number; offset?: number }; reply: { ok: true; sessions: import('./history.js').SessionInfo[] } | { error: string; detail?: string } };
  'history/messages': { body: { sessionId: string; dir?: string; limit?: number; offset?: number }; reply: { ok: true; messages: import('./history.js').HistoryMessage[] } | { error: string; detail?: string } };
  'history/tag': { body: { sessionId: string; tag: string | null; dir?: string }; reply: { ok: true } | { error: string; detail?: string } };
  'history/rename': { body: { sessionId: string; title: string; dir?: string }; reply: { ok: true } | { error: string; detail?: string } };
  'history/fork': { body: { sessionId: string; dir?: string; upToMessageId?: string; title?: string }; reply: { ok: true; sessionId: string } | { error: string; detail?: string } };
}
