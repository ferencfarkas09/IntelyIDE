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
  path: string;
  exists: boolean;
  isGit: boolean;
  branch?: string;
  dirty?: boolean;
  origin?: string;
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
  repos(id: string, repoIds: string[]): Promise<RepoState[]>;
  /** Clones the repository's origin on the server, with the server's own git credentials. */
  clone(id: string, repoId: string): Promise<void>;
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
    clone: (id, repoId) => call("servers_clone", { id, repoId }),
    sshCommand: (id) => call("servers_ssh_command", { id }),
    onSetup: (cb) => subscribe<SetupEvent>("servers:setup", cb),
    onStatus: (cb) => subscribe<{ id: string; status: ServerStatus }>("servers:status", (p) => cb(p.id, p.status)),
  };
}
