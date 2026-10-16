import type { AgentEvent } from "../store/agent-types";
import type { Unsubscribe } from "./index";
import { call, subscribe } from "./rpc";
import { createTauriTeamMemory, type TeamMemoryIpc } from "./teamMemory";

export type { TeamMemoryPending, TeamMemoryPendingAsk, TeamMemoryPendingChoice, TeamMemoryChoice, TeamMemoryConflict, TeamMemoryFile, TeamMemoryIpc, TeamMemoryProject, TeamMemoryStatus } from "./teamMemory";

export type TeamRole = "admin" | "member";

export interface TeamMember {
  id: string;
  name: string;
  role: TeamRole;
  online: boolean;
  /** A short status word the member set ("busy"); empty when none. */
  state: string;
  me: boolean;
}

/** The one-time invite of an admin. `code` is the text a joiner pastes; `qr` is the same text for the QR. */
export interface TeamInvite {
  code: string;
  qr: string;
  expiresAt: number;
}

/** Somebody has proven the code and waits for the admin to compare the six digits. */
export interface TeamJoinRequest {
  id: string;
  name: string;
  sas: string;
}

/** What an invite code points to, read on this Mac without any network access. */
export interface TeamJoinPreview {
  /** `host` or `host:port`, lowercase: the relay the invite points to. */
  relayHost: string;
  /** This Mac already trusts that relay host (or it is a local development relay). */
  trusted: boolean;
  /** A relay on this machine (loopback); `trusted` is then true. */
  local: boolean;
  /** First 8 characters of the team id (to read aloud). */
  teamId: string;
  /** First 8 characters of the inviting admin's member id. */
  adminId: string;
}

/** The joiner's side: `confirm` shows `sas` and waits for the person. */
export interface TeamJoining {
  stage: "connecting" | "waitingAdmin" | "confirm" | "waitingWelcome";
  sas?: string | null;
}

export interface TeamView {
  state: "none" | "joining" | "member";
  teamId?: string | null;
  relay: string;
  /** The key epoch; it grows by one every time a member is revoked. */
  epoch: number;
  connected: boolean;
  role?: TeamRole | null;
  members: TeamMember[];
  invite?: TeamInvite | null;
  joinRequest?: TeamJoinRequest | null;
  joining?: TeamJoining | null;
  auditEntries: number;
  /** The relay closed this member's socket as removed. Nothing was wiped: the person decides (`forget`). */
  removed?: boolean;
  /** The audit log could not be opened (changed outside the app). Team works, but nothing is recorded. */
  auditError?: string | null;
  /** The last problem worth telling the person (a message that had to be dropped, a state file that could not be saved). */
  error?: string | null;
}

export interface TeamPresence {
  id: string;
  online: boolean;
  state: string;
}

/** What a card of a shared run says: `waiting` = the owner has a permission card or a question open. */
export type TeamRunState = "running" | "waiting" | "idle" | "error";

/** One run a teammate shares. */
export interface TeamRun {
  memberId: string;
  memberName: string;
  online: boolean;
  runId: string;
  projectKey: string;
  projectName: string;
  title: string;
  state: TeamRunState;
  provider: string;
  model: string;
  startedAt: number;
  updatedAt: number;
}

/** New events of a teammate's run. The diff of a `tool.result` also carries `truncated`. */
export interface TeamRunEvents {
  memberId: string;
  runId: string;
  events: AgentEvent[];
}

/** An open project: `key` is absent when the folder has no `git remote origin` (it cannot be shared). */
export interface TeamProject {
  repoId: string;
  name: string;
  key: string | null;
  shared: boolean;
  /** Teammates may ask for a snapshot of this project's changes (`workspaceProjects`, off by default). */
  workspace: boolean;
  /** Memory files and `CLAUDE.md` are shared with the team (`memoryProjects`, beta, off by default). */
  memory: boolean;
  /** The repository's `CLAUDE.md` is shared too (`claudeMdProjects`, own switch, off by default). */
  claudeMd: boolean;
}

export type TeamNoteKind = "note" | "followup";

/** A note a teammate sent into one of your runs; it waits for you (or was passed on at once when `auto`). */
export interface TeamNoteIn {
  /** `followup`: a suggestion for a run that is not working; it always waits for the owner's click. */
  kind: TeamNoteKind;
  memberId: string;
  memberName: string;
  runId: string;
  noteId: string;
  text: string;
  at: number;
  /** The member is in `autoAcceptNotesFrom`: no decision is asked. */
  auto: boolean;
}

/** Where a note you sent stands, as the owner's machine reported it. */
export type TeamNoteStatus = "sent" | "received" | "accepted" | "rejected" | "delivered" | "dropped" | "refused";

export interface TeamSentNote {
  kind: TeamNoteKind;
  memberId: string;
  runId: string;
  noteId: string;
  status: TeamNoteStatus;
  /** Why it was refused or dropped (`rate`, `notLive`, `busy`, `notShared`, `unsupported`, `unknownRun`, ...). */
  reason?: string | null;
  at: number;
}

/** One changed file of a teammate's workspace. `skipped`: why there is no (full) diff. */
export interface TeamWorkspaceFile {
  path: string;
  /** `M`, `A`, `D`, `R`, `U` (untracked), `C` (conflicted), `T`, `S`. */
  status: string;
  /** Unified diff, redacted. */
  diff: string;
  truncated: boolean;
  skipped?: "secret" | "binary" | "large" | "unreadable" | "limit" | null;
}

/** One commit of a teammate's checked-out branch. `oid` is the first 10 characters, `at` is in ms, `author` is the git author name. */
export interface TeamSnapshotCommit {
  oid: string;
  subject: string;
  author: string;
  at: number;
  /** Not on the upstream branch yet. */
  unpushed: boolean;
}

export interface TeamSnapshot {
  id: string;
  projectKey: string;
  branch: string | null;
  ahead: number;
  behind: number;
  takenAt: number;
  files: TeamWorkspaceFile[];
  truncated: boolean;
  /** Up to 40 newest commits of the branch, newest first (empty from old senders). */
  commits: TeamSnapshotCommit[];
  /** The upstream branch, e.g. `origin/main`. */
  upstream?: string | null;
}

export interface TeamWorkspaceEvent {
  memberId: string;
  snapshot: TeamSnapshot;
}

/** `off` = the owner has not switched the project on, `rate` = asked too soon, `noProject`, `damaged`, `unavailable`. */
export interface TeamWorkspaceDenied {
  memberId: string;
  projectKey: string;
  reason: string;
}

/** One message of the chat thread of a shared run. `authorName` is empty when the author left the team. */
export interface TeamChatMsg {
  msgId: string;
  author: string;
  authorName: string;
  text: string;
  at: number;
  mine: boolean;
}

/** New message(s) of a thread (`ownerId` null: a run of this install). `history`: the answer to `chatRequest`. */
export interface TeamChatEvent {
  ownerId: string | null;
  runId: string;
  msgs: TeamChatMsg[];
  history: boolean;
}

/** The owner refused a message: `rate`, `unknownRun`, `notMember`, `invalid`, `offline`. */
export interface TeamChatDenied {
  ownerId: string | null;
  runId: string;
  msgId: string;
  reason: string;
}

/** `available`: the run's project is shared, so the run toggle means something. */
export interface TeamRunShare {
  available: boolean;
  shared: boolean;
}

/**
 * Team collaboration, phases T1 to T4: create a team on your relay, invite people with a one-time code, see who is online, revoke, leave,
 * follow shared runs, send a note into a teammate's run (the owner decides) and look at a teammate's workspace changes (read-only).
 * Everything the relay carries is ciphertext. Rejects with `{ code, message }`.
 */
export interface TeamIpc {
  status(): Promise<TeamView>;
  members(): Promise<TeamMember[]>;
  create(name: string): Promise<TeamView>;
  /** Admin: opens a one-time invite (10 minutes, one person). */
  invite(): Promise<TeamInvite>;
  /** Joiner: paste the code from an admin. The six digits appear in `joining.sas` once the handshake ran. */
  join(code: string, name: string, trustRelay?: boolean): Promise<TeamView>;
  /** Joiner: reads the pasted text (no network). Rejects with code `invalidCode` when it is not an invite. */
  joinPreview(code: string): Promise<TeamJoinPreview>;
  /** Joiner: the six digits match (`true`) or do not (`false`, the join is abandoned). */
  joinConfirm(accept: boolean): Promise<TeamView>;
  /** Admin: let the person who asked in (`true`) or send them away (`false`). */
  joinDecide(accept: boolean): Promise<TeamView>;
  /** Admin: removes a member and starts a new key epoch for everybody who stays. */
  revoke(memberId: string): Promise<TeamView>;
  /** Forgets the team on this machine (an admin can only leave a team of one). */
  leave(): Promise<TeamView>;
  /** After "you were removed": forgets the team on this machine and starts over with a new identity. */
  forget(): Promise<TeamView>;
  /** The runs the other members share right now (read-only; there is no way to answer or start anything on their side). */
  runs(): Promise<TeamRun[]>;
  runEvents(memberId: string, runId: string): Promise<AgentEvent[]>;
  /** The open projects with their keys and whether this install shares them. */
  projects(): Promise<TeamProject[]>;
  setShare(projectKey: string, shared: boolean): Promise<void>;
  runShareState(runId: string): Promise<TeamRunShare>;
  /** Switches one run off (`false`: withdrawn from the team at once) or on again (what happens from now on). */
  runShare(runId: string, shared: boolean): Promise<void>;
  /** Notes waiting for your decision. */
  pendingNotes(): Promise<TeamNoteIn[]>;
  /** Accept hands the note to the run (as "Note from teammate X"); reject tells the sender. */
  noteDecide(memberId: string, noteId: string, accept: boolean): Promise<void>;
  /** Sends a note into a teammate's live Claude run. The owner's machine decides; the status comes back as `onNoteStatus`. */
  noteSend(memberId: string, runId: string, text: string): Promise<string>;
  sentNotes(memberId: string, runId: string): Promise<TeamSentNote[]>;
  /** Suggests a follow-up for a run that is not working. It only ever becomes a card on the owner's side; returns the note id. */
  followUpSend(memberId: string, runId: string, text: string): Promise<string>;
  /** The chat thread of a shared run (`ownerId` null: a run of this install). Human to human: the agent never sees it. */
  chatThread(ownerId: string | null, runId: string): Promise<TeamChatMsg[]>;
  /** Posts to the thread (a teammate's run needs its owner online). Resolves with the message id; the echo arrives as `onChat`. */
  chatSend(ownerId: string | null, runId: string, text: string): Promise<string>;
  /** Asks the owner for the history; the answer arrives as `onChat` with `history: true`. */
  chatRequest(ownerId: string, runId: string): Promise<void>;
  /** `autoAcceptNotesFrom`: member ids whose notes are passed on without asking (default none). */
  collabSettings(): Promise<{ autoAcceptNotesFrom: string[] }>;
  setAutoAccept(memberId: string, enabled: boolean): Promise<void>;
  setWorkspace(projectKey: string, enabled: boolean): Promise<void>;
  setMemory(projectKey: string, enabled: boolean): Promise<void>;
  setClaudeMd(projectKey: string, enabled: boolean): Promise<void>;
  /** Shared Claude memory (beta): status, conflicts, "sync now". */
  memory: TeamMemoryIpc;
  /** Asks a member for a snapshot of a project; it arrives as `onWorkspace` (or `onWorkspaceDenied`). */
  workspaceRequest(memberId: string, projectKey: string): Promise<void>;
  workspace(memberId: string, projectKey: string): Promise<TeamSnapshot | null>;
  onChat(cb: (e: TeamChatEvent) => void): Unsubscribe;
  onChatDenied(cb: (e: TeamChatDenied) => void): Unsubscribe;
  onNoteIn(cb: (n: TeamNoteIn) => void): Unsubscribe;
  onNoteStatus(cb: (n: TeamSentNote) => void): Unsubscribe;
  onWorkspace(cb: (e: TeamWorkspaceEvent) => void): Unsubscribe;
  onWorkspaceDenied(cb: (e: TeamWorkspaceDenied) => void): Unsubscribe;
  onRuns(cb: (runs: TeamRun[]) => void): Unsubscribe;
  onRunEvents(cb: (e: TeamRunEvents) => void): Unsubscribe;
  onChanged(cb: (view: TeamView) => void): Unsubscribe;
  onPresence(cb: (p: TeamPresence) => void): Unsubscribe;
}

export function createTauriTeam(): TeamIpc {
  return {
    status: () => call("team_status"),
    members: () => call("team_members"),
    create: (name) => call("team_create", { name }),
    invite: () => call("team_invite"),
    join: (code, name, trustRelay) => call("team_join", { code, name, trustRelay }),
    joinPreview: (code) => call("team_join_preview", { code }),
    joinConfirm: (accept) => call("team_join_confirm", { accept }),
    joinDecide: (accept) => call("team_join_decide", { accept }),
    revoke: (memberId) => call("team_revoke", { memberId }),
    leave: () => call("team_leave"),
    forget: () => call("team_forget"),
    runs: () => call("team_runs"),
    runEvents: (memberId, runId) => call("team_run_events", { memberId, runId }),
    projects: () => call("team_projects"),
    setShare: (projectKey, shared) => call("team_set_share", { projectKey, shared }),
    runShareState: (runId) => call("team_run_share_state", { runId }),
    runShare: (runId, shared) => call("team_run_share", { runId, shared }),
    pendingNotes: () => call("team_pending_notes"),
    noteDecide: (memberId, noteId, accept) => call("team_note_decide", { memberId, noteId, accept }),
    noteSend: (memberId, runId, text) => call("team_note_send", { memberId, runId, text }),
    sentNotes: (memberId, runId) => call("team_sent_notes", { memberId, runId }),
    followUpSend: (memberId, runId, text) => call("team_followup_send", { memberId, runId, text }),
    chatThread: (ownerId, runId) => call("team_chat_thread", { ownerId, runId }),
    chatSend: (ownerId, runId, text) => call("team_chat_send", { ownerId, runId, text }),
    chatRequest: (ownerId, runId) => call("team_chat_request", { ownerId, runId }),
    collabSettings: () => call("team_collab_settings"),
    setAutoAccept: (memberId, enabled) => call("team_set_auto_accept", { memberId, enabled }),
    setWorkspace: (projectKey, enabled) => call("team_set_workspace", { projectKey, enabled }),
    setMemory: (projectKey, enabled) => call("team_set_memory", { projectKey, enabled }),
    setClaudeMd: (projectKey, enabled) => call("team_set_claude_md", { projectKey, enabled }),
    memory: createTauriTeamMemory(),
    workspaceRequest: (memberId, projectKey) => call("team_workspace_request", { memberId, projectKey }),
    workspace: (memberId, projectKey) => call("team_workspace", { memberId, projectKey }),
    onChat: (cb) => subscribe<TeamChatEvent>("team:chat", cb),
    onChatDenied: (cb) => subscribe<TeamChatDenied>("team:chat-denied", cb),
    onNoteIn: (cb) => subscribe<TeamNoteIn>("team:note-in", cb),
    onNoteStatus: (cb) => subscribe<TeamSentNote>("team:note-status", cb),
    onWorkspace: (cb) => subscribe<TeamWorkspaceEvent>("team:workspace", cb),
    onWorkspaceDenied: (cb) => subscribe<TeamWorkspaceDenied>("team:workspace-denied", cb),
    onRuns: (cb) => subscribe<TeamRun[]>("team:runs", cb),
    onRunEvents: (cb) => subscribe<TeamRunEvents>("team:run-events", cb),
    onChanged: (cb) => subscribe<TeamView>("team:changed", cb),
    onPresence: (cb) => subscribe<TeamPresence>("team:presence", cb),
  };
}
