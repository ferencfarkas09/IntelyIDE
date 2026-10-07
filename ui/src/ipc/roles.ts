import type { Effort, PermissionMode } from "@intely/protocol";
import type { RepoId } from "./index";
import { createBackendRoles } from "./rolesBackend";

export interface Role {
  id: string;
  name: string;
  description?: string;
  /** Provider id from `RoleProviderCaps`; absent means the first provider offered. */
  provider?: string;
  model: string;
  /** Absent or null: the model has no effort control (shown as n/a). */
  effort?: Effort | null;
  permission?: PermissionMode;
  /** Tool names the role may use. */
  tools: string[];
  /** Hex colour of the role's dot. */
  color?: string;
  /** Repositories a new run proposes by default. */
  defaultRepoIds?: string[];
  systemPrompt?: string;
  /** Where the role is stored: `~/.claude/agents` (global) or a repo's `.claude/agents`. */
  scope?: "global" | "repo";
  repoId?: RepoId;
  /** Repositories the role may run on; empty or absent: all. */
  repoScope?: RepoId[];
  /** Placeholder: whether the role may be started remotely. */
  remoteStartable?: boolean;
  /** Warning CODES from the engine (`reserved`, `toolsUnparsable`, ...); the UI words them. */
  warnings?: string[];
  /** Where `permission` came from (the overlay, the file's permissionMode, its tools, ...). Absent on an old engine. */
  permissionSource?: PermissionSource;
  /** Machine reason: `overlay`, `permissionMode:<v>`, `tools:readOnly`, `tools:write`, `tools:all`, `tools:none`. */
  permissionReason?: string;
  disallowedTools?: string[];
  maxTurns?: number;
  /** Hash of the effective fields: two copies with the same hash are identical. */
  contentHash?: string;
  /** A host built-in (no file). */
  builtin?: boolean;
  canEdit?: boolean;
  canRun?: boolean;
  /** Repository copies are `untrusted` until their hash is approved; global files and built-ins are `trusted`. */
  trust?: RoleTrust;
  /** The editor sets it when the user picks a permission, so the engine pins it in the overlay (otherwise it stays derived). */
  permissionExplicit?: boolean;
}

export type RoleTrust = "trusted" | "untrusted" | "approved";
export type PermissionSource = "overlay" | "frontmatter" | "tools" | "allTools" | "default" | "overlayCorrupt" | "ceiling";
export type WinnerReason = "onlyCopy" | "identical" | "global" | "pinned" | "primaryRepo" | "builtIn";
export type ExcludeReason = "hidden" | "otherProvider" | "noDescription" | "reservedName" | "promptTooLarge" | "repoScope" | "tooMany" | "untrusted";

/** One file of a group. */
export interface RoleCopy {
  id: string;
  scope: "global" | "repo";
  repoId?: RepoId;
  path: string;
  sameAsWinner: boolean;
  fieldsDiffer: string[];
  /** Hash and trust of THIS copy (needed to approve one repository copy). */
  contentHash?: string;
  trust?: RoleTrust;
  /** Same name twice in one directory: kept only so it can be deleted. */
  shadowedByDuplicate?: boolean;
  warnings?: string[];
}

/** All copies of one role name, plus the built-in of that name; the unit the Roles table shows. */
export interface RoleGroup {
  name: string;
  /** The winner with the overlay applied. */
  role: Role;
  copies: RoleCopy[];
  winnerId?: string;
  winnerReason: WinnerReason;
  conflict: boolean;
  pin?: string;
  pinMissing: boolean;
  hidden: boolean;
  builtinShadowed: boolean;
  diffs: RoleDrift[];
  delegate: { ok: boolean; reason?: ExcludeReason };
}

/** A role whose overlay permission differs from what its file derives (0.1.0 pinned every saved role read-only). */
export interface PermissionMismatch {
  id: string;
  overlay: PermissionMode;
  derived: PermissionMode;
  reason: string;
}

export interface DeletePreview {
  name: string;
  files: { id: string; path: string; scope: "global" | "repo"; repoId?: RepoId; /** Canonical target when the file sits in a linked global directory. */ symlinkTarget?: string }[];
  backupDir?: string;
  /** The global agents directory is a link: the delete needs the name typed a second time. */
  linkTarget?: string;
}

/** Side information of the Roles table: the overlay state, the migration list, directories that were skipped. */
export interface RolesStatus {
  overlayCorrupt: boolean;
  overlayBackup?: string;
  mismatches: PermissionMismatch[];
  skippedDirs: { repoId: RepoId; path: string; code: string; target?: string }[];
  globalDirTarget?: string;
  globalDir: string;
}

export interface DeleteReport {
  deleted: { id: string; path: string }[];
  backups: string[];
}

/** A role whose saved definition differs from the preset it came from. */
export interface RoleDrift {
  roleId: string;
  fields: string[];
  /** Set when the difference is between the global copy and the copy kept in a repo. */
  repoId?: string;
  global?: Role;
  repo?: Role;
}

/** What a provider offers a role: the editor's dropdowns are built from this, nothing is hard-coded. */
export interface RoleProviderCaps {
  provider: string;
  label: string;
  models: { id: string; label: string; /** Empty: the model has no effort control. */ effortLevels: Effort[] }[];
  permissionModes: PermissionMode[];
  tools: string[];
}

export interface RolesIpc {
  list(): Promise<Role[]>;
  /**
   * Rejects with `invalidSelection` when the role is not valid for its provider. A save that changes a role file on disk
   * rejects with `confirmWrite` until the caller passes `confirmWrite: true` (after the user agreed; the old file is backed up).
   */
  save(role: Role, opts?: { confirmWrite?: boolean }): Promise<Role>;
  drift(): Promise<RoleDrift[]>;
  /** Makes the global and the repo copy equal: `keep` says which one wins. */
  resolveDrift(roleId: string, repoId: string, keep: "global" | "repo", opts?: { confirmWrite?: boolean }): Promise<void>;
  /** Replaces the roles with the Happy model tiering preset and returns them. */
  presetHappyTiering(opts?: { confirmWrite?: boolean }): Promise<Role[]>;
  capabilities(): Promise<RoleProviderCaps[]>;
  /** One entry per role name (copies grouped, winner chosen); what the Roles table shows. */
  groups(): Promise<RoleGroup[]>;
  /** Hides or shows a whole group; only the overlay changes, never a role file. */
  setHidden(name: string, hidden: boolean): Promise<RoleGroup>;
  /** `pin`: `"global"` or `"repo:<repoId>"`; null removes the pin. Overlay only. */
  setPin(name: string, pin: string | null): Promise<RoleGroup>;
  /** Approves (or withdraws) a repository copy by its content hash. Overlay only. */
  setTrust(name: string, hash: string, trusted: boolean): Promise<RoleGroup>;
  /** What deleting would touch: paths, canonical symlink target, the backup directory. */
  deletePreview(roleIds: string[]): Promise<DeletePreview>;
  /** Rejects with a code (`confirmDelete`, `builtinNoFile`, `outsideAgentsDir`, `noBackupDir`, `readOnly`, `testJail`, `unknownRole`, `overlayCorrupt`, `io`). */
  delete(roleIds: string[], typed: string, opts?: { typedLink?: string }): Promise<DeleteReport>;
  /** The overlay state, the roles whose pinned permission differs from their file, and skipped directories. */
  status(): Promise<RolesStatus>;
  /** Replaces a damaged `roles-overlay.json` with an empty one (the unreadable bytes stay in `.bak`). */
  resetOverlay(): Promise<void>;
  /** Removes the overlay `permission` key of these roles (the permission is derived again); nothing else is touched. */
  useAutomatic(roleIds: string[]): Promise<void>;
}

export function createTauriRoles(): RolesIpc {
  return createBackendRoles();
}
