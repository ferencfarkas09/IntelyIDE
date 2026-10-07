import type {
  ChangedFile,
  CommitRequest,
  DiffSource,
  DoctorReport,
  EngineStatus,
  EnvStatus,
  FileContents,
  Hunk,
  OpEvent,
  OpResult,
  OutgoingInfo,
  PullMode,
  PushRequest,
  RepoSnapshot,
  RunStarted,
  UntrackedList,
  Workspace,
} from "../bindings";
import type { FileSelection } from "../modules/attachments/types";
import type {
  AgentAttachment,
  AgentEvent,
  AgentStartRequest,
  AgentSummary,
  AutoInfo,
  McpServerStatus,
  PermissionDecision,
  PermissionMode,
  QuestionAnswer,
  RoleInfo,
} from "../store/agent-types";
import { createMockIpc } from "./mock";
import type { IpcNamespaces } from "./namespaces";
import { createTauriIpc } from "./tauri";

export type * from "../bindings";

export type RepoId = string;

export type Unsubscribe = () => void;

/**
 * Rejections of every command carry an `EngineError` (see `toEngineError` in `rpc.ts`). The flat methods predate the modules;
 * new features add methods to their own namespace (`ipc.files`, `ipc.graph`, ... see `namespaces.ts`) instead.
 */
export interface Ipc extends IpcNamespaces {
  workspaceGet(): Promise<Workspace>;
  workspaceSave(ws: Workspace): Promise<Workspace>;
  engineStatus(): Promise<EngineStatus>;
  snapshotGet(repoId: string): Promise<RepoSnapshot>;
  /** `null` refreshes all repos; results arrive through `onRepoSnapshot`. */
  snapshotRefresh(repoId: string | null): Promise<void>;
  listUntracked(repoId: string, dir: string, limit: number): Promise<UntrackedList>;
  /** Secret files return empty contents unless `reveal` is true. */
  fileContents(
    repoId: string,
    path: string,
    origPath: string | undefined,
    source: DiffSource,
    reveal?: boolean,
  ): Promise<FileContents>;
  fileHunks(repoId: string, path: string, source: DiffSource): Promise<Hunk[]>;
  commitMessageLast(repoId: string): Promise<string>;
  /** Progress arrives as `OpEvent`s, the final state as one `OpResult`. */
  commitStart(req: CommitRequest): Promise<RunStarted>;
  commitCancel(runId: string): Promise<void>;
  pushPlan(repoIds: string[], refetch: boolean): Promise<OutgoingInfo[]>;
  pushCommitFiles(repoId: string, oid: string): Promise<ChangedFile[]>;
  pushStart(req: PushRequest): Promise<RunStarted>;
  pushCancel(runId: string): Promise<void>;
  pull(repoId: string, mode: PullMode): Promise<RunStarted>;
  fetch(repoId: string): Promise<RunStarted>;
  setPushTarget(repoId: string, localBranch: string, remote: string, branch: string): Promise<Workspace>;
  doctor(): Promise<DoctorReport>;

  agentRoles(): Promise<RoleInfo[]>;
  /** What an Auto run on these repositories would start with (lead, delegates, exclusions, queue reason, budget). Async: it detects the CLI. `mode` only steers the queued-behind preview (writer or not). */
  agentsAutoInfo(repoIds: string[], mode?: PermissionMode): Promise<AutoInfo>;
  /**
   * `opts.runWithoutSafetyNet`: start although a repo cannot be snapshotted for Rewind (the engine refuses with `noSafetyNet` otherwise).
   * `opts.confirmBypass`: the user confirmed the Bypass dialog (a `bypass` request without it is refused with `bypassNotConfirmed`).
   */
  agentStart(req: AgentStartRequest, opts?: { runWithoutSafetyNet?: boolean; confirmBypass?: boolean }): Promise<AgentSummary>;
  /** `files`: attachments of the composer draft (drag-drop, paste, picker); see modules/attachments. */
  agentSend(agentId: string, text: string, attachments?: AgentAttachment[], files?: FileSelection): Promise<void>;
  /** Ends the turn with `turn.end(cancelled)`. */
  agentInterrupt(agentId: string): Promise<void>;
  /**
   * `extra.mode`: an ExitPlanMode approval continues the run in this mode (`ask`, `edit` or `automatic`).
   * `extra.feedback`: the user's text when an ExitPlanMode request is rejected.
   */
  agentAnswerPermission(agentId: string, requestId: string, decision: PermissionDecision, extra?: { mode?: PermissionMode; feedback?: string }): Promise<void>;
  /** Switches the permission mode of a run live; rejects with the codes of the modes spec (`modeNotSupported`, `bypassNotConfirmed`, `writeLease`, ...). */
  agentSetPermission(agentId: string, mode: PermissionMode, opts?: { confirmBypass?: boolean }): Promise<AgentSummary>;
  /** The modes a NEW run of this provider may start in (provider support minus what the kill switch disables). */
  agentModes(provider: string): Promise<PermissionMode[]>;
  /** The live MCP servers of a run with their tools (what the session's CLI reports); rejects with `notRunning` when the session is not live. */
  agentMcpStatus(agentId: string): Promise<McpServerStatus[]>;
  /** Asks the session to reconnect one MCP server; answers with the fresh status. */
  agentMcpReconnect(agentId: string, server: string): Promise<McpServerStatus[]>;
  agentAnswerQuestion(agentId: string, requestId: string, answer: QuestionAnswer): Promise<void>;
  agentList(): Promise<AgentSummary[]>;
  /** Persisted events of one run (JSONL log) with `seq` greater than `afterSeq`. */
  agentHistory(agentId: string, afterSeq?: number): Promise<AgentEvent[]>;
  /** Placeholder until Rewind lands (Phase 2b): restores the repo snapshots taken before the run. */
  agentRewind(agentId: string): Promise<void>;
  /** Tracked files of a repo matching `query` (the @mention picker), best matches first. */
  agentRepoFiles(repoId: string, query: string, limit: number): Promise<string[]>;
  /**
   * One flag per repo-relative path: the file runs code when the human commits, pushes, installs, lints, tests or builds
   * (git hooks, `package.json`, tool configs, CI). The list lives in the Rust agent policy; the Commit panel warns about them.
   */
  execSurfaceCheck(paths: string[]): Promise<boolean[]>;

  onRepoSnapshot(cb: (s: RepoSnapshot) => void): Unsubscribe;
  onOpEvent(cb: (e: OpEvent) => void): Unsubscribe;
  onOpResult(cb: (r: OpResult) => void): Unsubscribe;
  onEngineEnv(cb: (e: EnvStatus) => void): Unsubscribe;
  /** Normalized events arrive in batches (up to 33 ms or 64 events), gap-free `seq` per agent. */
  onAgentEvents(cb: (events: AgentEvent[]) => void): Unsubscribe;
}

/**
 * Real IPC inside the Tauri webview, the deterministic mock (`?scenario=`) in a plain browser and in tests.
 * A production build has no mock (the bundler drops it with the dead branch) unless built with VITE_MOCK_IPC=1.
 */
export const ipc: Ipc =
  (typeof window !== "undefined" && window.__TAURI_INTERNALS__) || !(import.meta.env.DEV || import.meta.env.VITE_MOCK_IPC)
    ? createTauriIpc()
    : createMockIpc(new URLSearchParams(globalThis.location?.search).get("scenario") ?? "normal", { persistRegistry: true });

// Development only: the browser dry run of the e2e scenarios (.scratch/pw) steers the mock through this handle.
if (import.meta.env.DEV && typeof window !== "undefined" && !window.__TAURI_INTERNALS__) (window as unknown as { __intelyIpc?: Ipc }).__intelyIpc = ipc;
