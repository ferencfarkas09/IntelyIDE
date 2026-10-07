import { call, subscribe } from "./rpc";
import type { Unsubscribe } from "./index";
import type { Workspace } from "../bindings";

/*
 * Workspaces: the registry of named repository sets ((design notes: workspaces-spec) 4.3 to 4.9, Appendix B and D).
 * The wire types mirror Appendix B; they move to `../bindings` when the Rust side generates them (C1 M1) and this file
 * then re-exports them. Rust never sends English text: warnings, busy labels and errors are codes plus data.
 */

export type WorkspaceOrigin = "created" | "duplicate" | "openedFolder" | "scanned" | "migrated";

export interface WorkspaceEntry {
  id: string;
  name: string;
  color: string;
  order: number;
  createdAt: number;
  lastOpenedAt: number | null;
  origin: WorkspaceOrigin;
}

export interface RepoSummary {
  id: string;
  name: string;
  color: string;
  badge: string;
  path: string;
}

export interface WorkspaceSummary extends WorkspaceEntry {
  repos: RepoSummary[];
}

export interface BackupInfo {
  name: string;
  at: number;
  workspaces: number;
}

export type RegistryProblemKind = "corrupt" | "newerVersion" | "legacyUnreadable" | "ioError" | "testJail" | "otherInstance";

export interface RegistryProblem {
  kind: RegistryProblemKind;
  message: string;
  backups: BackupInfo[];
}

export type OpenErrorReason = "allMissing" | "fileDamaged" | "fileMissing";

export interface RegistryView {
  version: 1;
  rev: number;
  /** The epoch of the running engine generation; a freshly booted page sends it back with its mutating commands. */
  epoch?: number;
  activeId: string | null;
  pinned: boolean;
  workspaces: WorkspaceSummary[];
  problem: RegistryProblem | null;
  openError: { id: string; reason: OpenErrorReason } | null;
  /** This launch moved the legacy `workspace.json` into the registry (shown once as a toast). */
  justMigrated?: boolean;
  /** The last two launches never reached `ready` (crash-loop guard): start on Welcome with a notice naming this workspace. */
  crashLoop?: { id: string; name: string } | null;
}

export type RepoStatus = "ok" | "missing" | "volumeMissing" | "notRepo" | "noAccess" | "unresponsive";

export interface RepoProbe {
  repoId: string;
  status: RepoStatus;
  branch: string | null;
  detached: boolean;
}

export interface WorkspaceProbe {
  id: string;
  repos: RepoProbe[];
}

export type BusyKind = "gitRun" | "gitOp" | "agent" | "devServer" | "check" | "terminal" | "preview" | "mongo" | "unsaved";

export interface BusyItem {
  kind: BusyKind;
  count: number;
  /** Data (server names, repo names, file names), never English sentences. */
  labels: string[];
}

export interface BusyReport {
  blocking: BusyItem[];
  confirmable: BusyItem[];
}

export interface SwitchWarning {
  /** e.g. `runnerStuck`; translated by the UI. */
  code: string;
  subsystem: string;
}

export interface Survivor {
  pid: number;
  port: number | null;
  cwd: string;
  kind: "devServer" | "terminal" | "check" | "preview";
}

export interface SwitchResult {
  activeId: string | null;
  epoch: number;
  warnings: SwitchWarning[];
  survivors: Survivor[];
}

export interface CreateResult {
  entry: WorkspaceEntry;
  reused: boolean;
}

/** One repository to register: the token comes from the path picker, the rest overrides the suggested display data. */
export interface RepoRedeem {
  token: string;
  name?: string;
  badge?: string;
  color?: string;
  /** Required (`trustRequired`) when the picked repository's config can run programs. */
  trust?: boolean;
}

export interface CreateRequest {
  name: string;
  color?: string;
  repos: RepoRedeem[];
  origin?: WorkspaceOrigin;
}

export interface SwitchOptions {
  /** Stop the confirmable blockers (agents, servers, ...) instead of answering `workspaceBusy`. */
  force: boolean;
  /** Detach the engine but keep `activeId` in the registry (all folders of the active workspace are missing at launch). */
  keepActive?: boolean;
}

export interface RelocateRequest {
  workspaceId?: string;
  repoId: string;
  token: string;
  trust?: boolean;
  confirmDifferent?: boolean;
}

export interface SwitchingEvent {
  fromId: string | null;
  toId: string | null;
  epoch: number;
}

export interface ChangedEvent {
  activeId: string | null;
  epoch: number;
}

export interface WorkspacesIpc {
  list(): Promise<RegistryView>;
  /** Cheap and bounded: branch and folder status per repo, without a git process. `ids` omitted = every workspace. */
  probe(ids?: string[]): Promise<WorkspaceProbe[]>;
  create(req: CreateRequest): Promise<CreateResult>;
  rename(id: string, name: string): Promise<WorkspaceEntry>;
  recolor(id: string, color: string): Promise<WorkspaceEntry>;
  duplicate(id: string, name?: string): Promise<WorkspaceEntry>;
  /** `confirm` must be true; the active workspace is refused (`workspaceActive`). Nothing on disk is deleted. */
  remove(id: string, confirm: boolean): Promise<void>;
  reorder(ids: string[]): Promise<void>;
  busy(): Promise<BusyReport>;
  /** `null` closes the workspace (detached engine). The page reloads afterwards, whatever the outcome. */
  switch(id: string | null, opts: SwitchOptions): Promise<SwitchResult>;
  /** Called by a freshly booted page: clears the crash-loop marker and the switching gate. */
  ready(epoch: number): Promise<void>;
  killSurvivor(pid: number): Promise<void>;
  /** Registers repositories in the open workspace. */
  addRepos(repos: RepoRedeem[]): Promise<Workspace>;
  relocateRepo(req: RelocateRequest): Promise<void>;
  reveal(workspaceId: string, repoId: string): Promise<void>;
  restoreBackup(backupName: string): Promise<RegistryView>;
  startFresh(): Promise<RegistryView>;
  onSwitching(cb: (e: SwitchingEvent) => void): Unsubscribe;
  onChanged(cb: (e: ChangedEvent) => void): Unsubscribe;
  /** Any registry write (`workspaces:changed`), so an open switcher refreshes. */
  onListChanged(cb: (e: { rev: number }) => void): Unsubscribe;
}

export function createTauriWorkspaces(): WorkspacesIpc {
  return {
    list: () => call("workspaces_list"),
    probe: (ids) => call("workspaces_probe", { ids }),
    create: (req) => call("workspaces_create", { req }),
    rename: (id, name) => call("workspaces_rename", { id, name }),
    recolor: (id, color) => call("workspaces_recolor", { id, color }),
    duplicate: (id, name) => call("workspaces_duplicate", { id, name }),
    remove: (id, confirm) => call("workspaces_remove", { id, confirm }),
    reorder: (ids) => call("workspaces_reorder", { ids }),
    busy: () => call("workspaces_busy"),
    switch: (id, opts) => call("workspaces_switch", { id, force: opts.force, keepActive: opts.keepActive }),
    ready: (epoch) => call("workspaces_ready", { epoch }),
    killSurvivor: (pid) => call("workspaces_kill_survivor", { pid }),
    addRepos: (repos) => call("workspaces_add_repos", { repos }),
    relocateRepo: (req) => call("workspaces_relocate_repo", { ...req }),
    reveal: (workspaceId, repoId) => call("workspaces_reveal", { workspaceId, repoId }),
    restoreBackup: (backupName) => call("workspaces_restore_backup", { backupName }),
    startFresh: () => call("workspaces_start_fresh"),
    onSwitching: (cb) => subscribe("workspace:switching", cb),
    onChanged: (cb) => subscribe("workspace:changed", cb),
    onListChanged: (cb) => subscribe("workspaces:changed", cb),
  };
}
