import type { Change, ChangeKind, FileContents } from "../bindings";
import type { Unsubscribe } from "./index";
import { call, subscribe } from "./rpc";

/** A server the IDE can run agents on over SSH. The keys come from the user's ~/.ssh/config and agent; the IDE stores no secret. */
export interface ServerCfg {
  id: string;
  name: string;
  /** A host from ~/.ssh/config, or user@host. */
  destination: string;
  port?: number;
  /** Folder on the server that holds the repositories, e.g. `~/work`. */
  root: string;
  maxAgents: number;
  enabled: boolean;
  /** Where a repository lives on this server when it is not `<root>/<folder name>`: repository key to an absolute or `~/` path. */
  repoPaths?: Record<string, string>;
}

export interface ServerStatusError {
  code: string;
  message: string;
  hint?: string;
}

export interface ServerStatus {
  reachable: boolean;
  os?: string;
  arch?: string;
  home?: string;
  node: { version?: string; path?: string; ok: boolean };
  /** `loggedIn` is null when the check could not tell. */
  claude: { path?: string; version?: string; loggedIn?: boolean | null };
  git: { path?: string; version?: string };
  bundle: { version?: string; ok: boolean };
  sdk: { ok: boolean; version?: string; detail?: string };
  ready: boolean;
  checkedAt: string;
  error?: ServerStatusError;
}

export interface ServerView {
  cfg: ServerCfg;
  /** Absent until the first check. */
  status?: ServerStatus;
  /** Live runs on it now. */
  running: number;
}

export type SetupStepName = "probe" | "prepare" | "node" | "bundle" | "sdk" | "claude" | "verify";

export interface SetupEvent {
  id: string;
  step: SetupStepName;
  state: "started" | "done" | "skipped" | "failed" | "info";
  message: string;
}

export interface SetupOptions {
  installNode: boolean;
  installBundle: boolean;
  installSdk: boolean;
  installClaude: boolean;
}

export interface RepoState {
  name: string;
  /** Where it is looked for on the server (`~/...` or absolute); empty when the folder name cannot be used there. */
  path: string;
  /** The path comes from the server's mapping, not from `<root>/<folder name>`. */
  mapped?: boolean;
  exists: boolean;
  isGit: boolean;
  branch?: string;
  dirty?: boolean;
  origin?: string;
}

/** A workspace repository on a server: its state there and the key its folder is saved under. */
export interface RepoRow extends RepoState {
  repoId: string;
  key: string;
  /** `<root>/<folder name>`; absent when the folder name cannot be used there. */
  defaultPath?: string;
}

/** What a search of the server found for one workspace repository (nothing is saved by a search). */
export interface FoundRow {
  repoId: string;
  key: string;
  candidates: { path: string; origin?: string }[];
}

/** The read-only view of a repository's working copy on a server (`servers_changes`). */
export interface ServerChanges {
  /** `server(<name>)`: where these changes are. */
  source: string;
  /** `ok`, or why there is nothing to list: the folder is missing, it is no git repository, or git failed (`error`). */
  state: "ok" | "missing" | "notGit" | "error";
  /** The real folder on the server (links followed). */
  physical?: string | null;
  head?: string | null;
  branch?: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  origin?: string | null;
  changes: Change[];
  /** All changed files; more than `changes.length` when the list was cut at 500. */
  total: number;
  truncated: boolean;
  error?: string | null;
  updatedAtMs: number;
}

export type TransferDirection = "bring" | "send";

export interface TransferBlocked {
  path: string;
  code: string;
  reason: string;
}

/** What the confirmation dialog of a patch transfer shows; computing it changes nothing. */
export interface TransferPlan {
  direction: TransferDirection;
  files: { path: string; origPath?: string | null; kind: ChangeKind; untracked: boolean }[];
  tracked: number;
  untracked: number;
  serverHead?: string | null;
  localHead?: string | null;
  sameOrigin: boolean;
  sameHead: boolean;
  /** The destination has no uncommitted change; otherwise the person may choose "apply on top". */
  destinationClean: boolean;
  blocked: TransferBlocked[];
  /** Paths that run or configure something on their own, or become executable: they travel only with the extra tick. */
  risky: { path: string; code: string }[];
  /** Lines added and removed per file, as git reads the patch (`null` for a binary file). */
  stat: { path: string; added?: number | null; deleted?: number | null; binary: boolean }[];
  /** Size of the patch in bytes. */
  bytes: number;
  /** Identifies exactly this patch; the apply goes ahead only when it builds the same one. */
  patchId: string;
  /** Why nothing can happen at all, and what to do about it. */
  refusal?: { code: string; message: string } | null;
}

export interface TransferApplied {
  files: number;
  bytes: number;
}

export type ServerDraft = Omit<ServerCfg, "id"> & { id?: string };

/** Remote servers: connection settings, checks, one-click setup, repositories on the server. */
export interface ServersIpc {
  list(): Promise<ServerView[]>;
  /** An empty or missing id creates a server (the backend makes the id from the name). Rejects with `{ code, message }`. */
  save(cfg: ServerDraft): Promise<ServerCfg>;
  /** Refused while runs are live on the server. */
  remove(id: string): Promise<void>;
  probe(id: string): Promise<ServerStatus>;
  /** Progress arrives through `onSetup`; this resolves when the setup ended (a "failed" event carries the reason) and `onStatus` fires at the end. */
  setup(id: string, options: SetupOptions): Promise<void>;
  /** One state per workspace repository id, in the order given. */
  repos(id: string, repoIds: string[]): Promise<RepoRow[]>;
  /** One bounded read-only search of the server for git repositories, matched to the workspace repositories by origin. */
  findRepos(id: string, repoIds: string[]): Promise<FoundRow[]>;
  /** Saves the folder of one repository on the server (`null` = back to the default) and returns the server's entry. */
  setRepoPath(id: string, key: string, path: string | null): Promise<ServerCfg>;
  /** Clones the repository's origin on the server, with the server's own git credentials. */
  clone(id: string, repoId: string): Promise<void>;
  /** One read-only `git status` of the repository's folder on the server. Rejects with `{ code: "ssh" | ..., message }` when the server cannot be reached. */
  changes(id: string, repoId: string): Promise<ServerChanges>;
  /** Both sides of one changed file on the server, for the diff viewer. */
  file(id: string, repoId: string, file: string, origPath: string | undefined, untracked: boolean, reveal: boolean): Promise<FileContents>;
  /** Computes what a transfer would do. Changes nothing. */
  transferPlan(id: string, repoId: string, direction: TransferDirection): Promise<TransferPlan>;
  /** "Bring changes here": the server's uncommitted changes become uncommitted changes of the local working tree. Only after the person confirmed. */
  transferBring(id: string, repoId: string, onTop: boolean, planId: string, acceptRisky: boolean): Promise<TransferApplied>;
  /** "Send my changes there". Only after the person confirmed. */
  transferSend(id: string, repoId: string, onTop: boolean, planId: string, acceptRisky: boolean): Promise<TransferApplied>;
  /** The command line for a terminal, e.g. `ssh -p 2222 dev@build1`. */
  sshCommand(id: string): Promise<string>;
  onSetup(cb: (e: SetupEvent) => void): Unsubscribe;
  onStatus(cb: (id: string, status: ServerStatus) => void): Unsubscribe;
}

export function createTauriServers(): ServersIpc {
  return {
    list: () => call("servers_list"),
    save: (cfg) => call("servers_save", { cfg }),
    remove: (id) => call("servers_remove", { id }),
    probe: (id) => call("servers_probe", { id }),
    setup: (id, options) => call("servers_setup", { id, options }),
    repos: (id, repoIds) => call("servers_repos", { id, repoIds }),
    findRepos: (id, repoIds) => call("servers_find_repos", { id, repoIds }),
    setRepoPath: (id, key, path) => call("servers_set_repo_path", { id, key, path }),
    clone: (id, repoId) => call("servers_clone", { id, repoId }),
    changes: (id, repoId) => call("servers_changes", { id, repoId }),
    file: (id, repoId, file, origPath, untracked, reveal) => call("servers_file", { id, repoId, file, origPath: origPath ?? null, untracked, reveal }),
    transferPlan: (id, repoId, direction) => call("servers_transfer_plan", { id, repoId, direction }),
    transferBring: (id, repoId, onTop, planId, acceptRisky) => call("servers_transfer_bring", { id, repoId, onTop, planId, acceptRisky }),
    transferSend: (id, repoId, onTop, planId, acceptRisky) => call("servers_transfer_send", { id, repoId, onTop, planId, acceptRisky }),
    sshCommand: (id) => call("servers_ssh_command", { id }),
    onSetup: (cb) => subscribe<SetupEvent>("servers:setup", cb),
    onStatus: (cb) => subscribe<{ id: string; status: ServerStatus }>("servers:status", (p) => cb(p.id, p.status)),
  };
}
