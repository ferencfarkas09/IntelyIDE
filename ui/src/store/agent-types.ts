/**
 * The normalized agent protocol ((design notes: providers-plan) 1.4, 1.5, 4.5, 3.1) comes from `@intely/protocol`, which is
 * generated from `crates/agent_core`. This file re-exports it under the names the chat code uses and holds the few
 * types that exist only in the UI.
 */
import type { AgentEvent, AgentStartRequest as ProtocolStartRequest, AgentSummary as ProtocolSummary, EventKind as ProtocolPayload, StatusState, Tier } from "@intely/protocol";

export type {
  Actor,
  AgentAttachment,
  AgentEffective,
  AgentEvent,
  AttachmentRef,
  AutoInfo,
  AutoQueue,
  Cap,
  CapEntry,
  CapKey,
  CostBasis,
  DecidedBy,
  DelegateInfo,
  DelegateScope,
  Effort,
  ErrorClass,
  ExcludedDelegate,
  McpExposure,
  McpPolicy,
  McpServerInfo,
  McpServerState,
  McpServerStatus,
  McpToolInfo,
  ModeChangeReason,
  ModelTokens,
  NoteState,
  PermissionDecision,
  PermissionMode,
  PermissionOption,
  PermissionOutcome,
  PlanItem,
  ProviderCaps,
  QuestionAnswer,
  QuestionOption,
  RoleInfo,
  RunStatus,
  SessionAllowKind,
  SessionAllowOffer,
  StopReason,
  ToolClass,
  ToolDiff,
  ToolIntent,
  ToolKind,
  ToolStatus,
  UsageRecord,
} from "@intely/protocol";

/**
 * `location` (the id of the server a run lives on; absent = this Mac) is written here until the Rust type that generates
 * `@intely/protocol` carries it; the intersection stays valid once it does.
 */
export type AgentStartRequest = ProtocolStartRequest & { location?: string };
export type AgentSummary = ProtocolSummary & { location?: string };

export type ProviderId = "claude" | "mock" | (string & {});

export type AgentState = StatusState;
export type EnforcementTier = Tier;

/** The payload part of an event (`kind` and its fields), without the envelope. */
export type EventPayload = ProtocolPayload;
export type EventKind = AgentEvent["kind"];

/** An `@file` mention in the composer picker. */
export interface RepoFile {
  repoId: string;
  path: string;
}
