import type { Effort, PermissionMode } from "@intely/protocol";
import { t, type MessageKey } from "../../i18n";
import type { ExcludeReason, PermissionMismatch, Role, RoleCopy, RoleGroup, RoleProviderCaps, WinnerReason } from "../../ipc/roles";
import { modelLabel } from "../../components/chat/format";
import { REPO_PALETTE } from "../../ui-kit/repoPalette";

export const ROLE_COLORS: readonly string[] = REPO_PALETTE;

export const EFFORT_LADDER: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];
/** Getters, so the titles follow the language. */
export const PERMISSION_TITLES: Record<PermissionMode, string> = {
  get readOnly() {
    return t("roles.perm.readOnly");
  },
  get edit() {
    return t("roles.perm.edit");
  },
  get ask() {
    return t("roles.perm.ask");
  },
  get automatic() {
    return t("modes.automatic.label");
  },
  get bypass() {
    return t("modes.bypass.label");
  },
};
/** Tools that change files or run commands: a read-only role must not hold them. */
export const WRITING_TOOLS: readonly string[] = ["Edit", "Write", "Bash", "NotebookEdit"];

export type RoleField = "name" | "provider" | "model" | "effort" | "permission" | "tools" | "color";
export type RoleIssues = Partial<Record<RoleField, string>>;

/** The catalog's models, plus the one the file names when the catalog does not list it, so the select shows it. */
export const modelOptions = (models: readonly { id: string; label: string }[], current: string): { value: string; label: string }[] => {
  const out = models.map((m) => ({ value: m.id, label: m.label }));
  if (current && !out.some((o) => o.value === current)) out.push({ value: current, label: modelLabel(current) });
  return out;
};

/** The provider's tool chips, plus the tools the file lists that have no chip, so they stay visible and removable. */
export const toolChips = (offered: readonly string[], picked: readonly string[]): string[] => [...offered, ...picked.filter((x) => !offered.includes(x))];

export const providerOf = (role: Pick<Role, "provider">, caps: readonly RoleProviderCaps[]): RoleProviderCaps | undefined => caps.find((c) => c.provider === (role.provider ?? caps[0]?.provider));
export const modelOf = (role: Pick<Role, "provider" | "model">, caps: readonly RoleProviderCaps[]) => providerOf(role, caps)?.models.find((m) => m.id === role.model);

/** Effort levels the role's model accepts; empty means the model has no effort control (n/a). */
export const effortOptions = (role: Pick<Role, "provider" | "model">, caps: readonly RoleProviderCaps[]): Effort[] => modelOf(role, caps)?.effortLevels ?? [];

/** The accepted level closest to the wanted one, not above it unless nothing lower exists. */
export function clampEffort(wanted: Effort | null | undefined, levels: readonly Effort[]): Effort | null {
  if (levels.length === 0) return null;
  const want = EFFORT_LADDER.indexOf(wanted ?? "medium");
  const ranked = levels.map((l) => ({ l, i: EFFORT_LADDER.indexOf(l) })).sort((a, b) => a.i - b.i);
  return (ranked.filter((r) => r.i <= want).at(-1) ?? ranked[0]).l;
}

/** After a provider or model change: snaps model, effort, permission and tools back into what the provider offers. */
export function reconcile(role: Role, caps: readonly RoleProviderCaps[]): Role {
  const provider = providerOf(role, caps);
  if (!provider) return role;
  const model = provider.models.find((m) => m.id === role.model) ?? provider.models[0];
  const permission = role.permission && provider.permissionModes.includes(role.permission) ? role.permission : provider.permissionModes[0];
  return { ...role, provider: provider.provider, model: model?.id ?? role.model, effort: clampEffort(role.effort, model?.effortLevels ?? []), permission, tools: role.tools.filter((t) => provider.tools.includes(t) || isFileTool(provider.provider, t)) };
}

const NAME = /^[a-z][a-z0-9-]{1,30}$/;

/** A model the file names that the catalog does not list: an alias or any `claude-*` id. Kept as written, effort cannot be checked. */
export const isFileModel = (provider: string, model: string): boolean => provider === "claude" && /^(claude-[a-z0-9][a-z0-9._-]*|haiku|sonnet|opus|inherit|default)$/i.test(model);

/** Claude Code tools a role file may list that the editor has no chip for. */
const FILE_TOOLS = new Set(["WebSearch", "NotebookEdit", "MultiEdit", "TodoWrite", "LS", "Skill", "Task", "Agent", "TaskList", "TaskGet", "TaskCreate", "TaskUpdate", "TaskOutput", "TaskStop", "ReportFindings", "ExitPlanMode", "EnterPlanMode", "BashOutput", "KillShell", "AskUserQuestion", "SlashCommand"]);
export const isFileTool = (provider: string, tool: string): boolean => provider === "claude" && (FILE_TOOLS.has(tool) || /^(mcp__[\w.-]+(__[\w.*-]+)?|(Agent|Task)\([\w .,*-]*\))$/.test(tool));

/** CSS colour a role file may carry: `#rrggbb`, or a plain colour name (`yellow`, `pink`) as Claude Code agent files use. */
export const isRoleColor = (c: string): boolean => /^#[0-9a-f]{6}$/i.test(c) || /^[a-z]{3,20}$/i.test(c);

/** Why the role's provider may not run its permission mode (enforcement tier too low), or undefined. Supplied by the editor. */
export type ModeBlocker = (role: Pick<Role, "provider" | "permission">) => string | undefined;

export function validateRole(role: Role, caps: readonly RoleProviderCaps[], others: readonly Role[], blocker?: ModeBlocker): RoleIssues {
  const issues: RoleIssues = {};
  if (!NAME.test(role.name)) issues.name = t("roles.err.name");
  else if (others.some((o) => o.id !== role.id && o.name === role.name)) issues.name = t("roles.err.nameTaken");
  const provider = providerOf(role, caps);
  if (!provider) {
    issues.provider = t("roles.err.providerNA");
    return issues;
  }
  const model = provider.models.find((m) => m.id === role.model);
  if (!model && isFileModel(provider.provider, role.model)) {
    // a model that only the file knows: nothing to check against, nothing wrong
  } else if (!model) issues.model = t("roles.err.noModel");
  else if (model.effortLevels.length === 0 && role.effort) issues.effort = t("roles.err.noEffortControl");
  else if (model.effortLevels.length > 0 && (!role.effort || !model.effortLevels.includes(role.effort))) issues.effort = t("roles.err.pickEffort");
  if (!role.permission || !provider.permissionModes.includes(role.permission)) issues.permission = t("roles.err.noMode");
  else {
    const blocked = blocker?.(role);
    if (blocked) issues.permission = blocked;
  }
  if (role.builtin) return issues;
  // A file without a tools line means "all tools": nothing to pick, nothing wrong.
  if (role.tools.length === 0) {
    if (role.permissionSource !== "allTools") issues.tools = t("roles.err.needTool");
  }
  else if (role.tools.some((t) => !provider.tools.includes(t) && !isFileTool(provider.provider, t))) issues.tools = t("roles.err.toolsNA");
  else if (role.permission === "readOnly" && role.tools.some((t) => WRITING_TOOLS.includes(t))) issues.tools = t("roles.err.readOnlyTools", { tools: role.tools.filter((x) => WRITING_TOOLS.includes(x)).join(", ") });
  if (role.color && !isRoleColor(role.color)) issues.color = t("roles.err.color");
  return issues;
}

export const hasIssues = (issues: RoleIssues): boolean => Object.keys(issues).length > 0;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const FIELDS: (keyof Role)[] = ["name", "description", "provider", "model", "effort", "permission", "tools", "color", "defaultRepoIds", "systemPrompt"];
const LABELS = { name: "roles.f.name", description: "roles.f.description", provider: "roles.f.provider", model: "roles.f.model", effort: "roles.f.effort", permission: "roles.f.permission", tools: "roles.f.tools", color: "roles.f.color", defaultRepoIds: "roles.f.defaultRepos", systemPrompt: "roles.f.systemPrompt" } as const satisfies Record<string, MessageKey>;

export const isDirty = (draft: Role, saved: Role | undefined): boolean => !saved || FIELDS.some((f) => !same(draft[f], saved[f]));

const show = (field: string, value: unknown): string => {
  if (Array.isArray(value)) return value.length ? value.join(", ") : t("roles.none");
  if (value === null || value === undefined || value === "") return field === "effort" ? t("roles.na") : t("roles.none");
  if (field === "model") return modelLabel(String(value));
  return String(value);
};

export interface DriftRow {
  field: string;
  label: string;
  global: string;
  repo: string;
}

/** The fields that differ between the global copy of a role and the copy kept in a repo, as display strings. */
export function driftRows(global: Role, repo: Role): DriftRow[] {
  return FIELDS.filter((f) => !same(global[f], repo[f])).map((f) => ({ field: f, label: t(LABELS[f as keyof typeof LABELS]), global: show(f, global[f]), repo: show(f, repo[f]) }));
}

/** A fresh role with the provider's first model and mode and read-only tools; its id is unique among `taken`. */
export function newRole(caps: readonly RoleProviderCaps[], taken: readonly string[]): Role {
  let n = 1;
  while (taken.includes(`role-${n}`)) n++;
  const base: Role = { id: `role-${n}`, name: `role-${n}`, provider: caps[0]?.provider, model: "", effort: null, permission: "readOnly", tools: ["Read", "Grep", "Glob"], color: ROLE_COLORS[(taken.length) % ROLE_COLORS.length] };
  return reconcile(base, caps);
}

// ---- groups: one row per role name -------------------------------------------------------------------------------------------

export interface ScopeChip {
  kind: "global" | "repo" | "builtin";
  label: string;
}

/** The chips of a row: Global, one per repository that holds a copy, Built-in. Repository names come from the workspace. */
export function scopeChips(group: Pick<RoleGroup, "copies" | "role" | "builtinShadowed">, repoName: (id: string) => string): ScopeChip[] {
  const chips: ScopeChip[] = [];
  if (group.copies.some((c) => c.scope === "global")) chips.push({ kind: "global", label: t("roles.scope.global") });
  for (const c of group.copies) if (c.scope === "repo" && !chips.some((x) => x.kind === "repo" && x.label === repoName(c.repoId ?? ""))) chips.push({ kind: "repo", label: repoName(c.repoId ?? "") });
  if (group.role.builtin || group.builtinShadowed) chips.push({ kind: "builtin", label: t("roles.scope.builtin") });
  return chips;
}

/** Visible rows first (by name), hidden ones only when asked for. */
export function groupRows(groups: readonly RoleGroup[], showHidden: boolean): { rows: RoleGroup[]; hiddenCount: number } {
  const sorted = [...groups].sort((a, b) => a.name.localeCompare(b.name));
  return { rows: sorted.filter((g) => showHidden || !g.hidden), hiddenCount: groups.filter((g) => g.hidden).length };
}

/** Does the group have a file to delete? A pure built-in has none. */
export const canDelete = (g: Pick<RoleGroup, "copies">): boolean => g.copies.length > 0;
/** File ids a delete of the group (or one copy) removes. */
export const deleteTargets = (g: Pick<RoleGroup, "copies">, copyId?: string): string[] => (copyId ? g.copies.filter((c) => c.id === copyId).map((c) => c.id) : g.copies.map((c) => c.id));
/** Copies another trusted copy covers: the ones a repository needs approval for. */
export const untrustedCopies = (g: Pick<RoleGroup, "copies">): RoleCopy[] => g.copies.filter((c) => c.trust === "untrusted");

const WINNER_KEY = {
  onlyCopy: "roles.win.onlyCopy",
  identical: "roles.win.identical",
  global: "roles.win.global",
  pinned: "roles.win.pinned",
  primaryRepo: "roles.win.primaryRepo",
  builtIn: "roles.win.builtin",
} as const satisfies Record<WinnerReason, MessageKey>;
export const winnerReasonText = (r: WinnerReason): string => t(WINNER_KEY[r]);

const EXCLUDE_KEY = {
  hidden: "roles.excluded.hidden",
  otherProvider: "roles.excluded.otherProvider",
  noDescription: "roles.excluded.noDescription",
  reservedName: "roles.excluded.reservedName",
  promptTooLarge: "roles.excluded.promptTooLarge",
  repoScope: "roles.excluded.repoScope",
  tooMany: "roles.excluded.tooMany",
  untrusted: "roles.exclude.untrusted",
} as const satisfies Record<ExcludeReason, MessageKey>;
/** Why a role is not handed to the Auto lead; an unknown code from a newer engine shows as itself. */
export const excludeReasonText = (r: string): string => (r in EXCLUDE_KEY ? t(EXCLUDE_KEY[r as ExcludeReason]) : r);

const WRITING_NAMES = new Set(["Edit", "Write", "Bash", "NotebookEdit", "Monitor"]);

export interface PermissionText {
  /** What the role can do, in plain words. */
  means: string;
  /** Why it has this permission (its source). */
  why?: string;
  /** Short source label for the chip. */
  source?: string;
  /** The role may not exceed `ask` because the file comes from a repository. */
  ceiling: boolean;
}

/** The permission of a role in plain words: a role with Bash but no Edit "runs commands, cannot edit". */
export function permissionText(role: Pick<Role, "permission" | "permissionSource" | "permissionReason" | "canEdit" | "canRun" | "tools" | "provider">): PermissionText {
  const mode = role.permission ?? "readOnly";
  const source = role.permissionSource;
  const runsOnly = mode !== "readOnly" && role.canRun === true && role.canEdit === false;
  const means = runsOnly ? t("roles.permission.runsCommands") : t(`roles.perm.${mode}.means` as MessageKey);
  const writes = role.tools.filter((x) => WRITING_NAMES.has(x.split("(")[0]));
  const reason = role.permissionReason ?? "";
  let why: string | undefined;
  switch (source) {
    case "overlay":
      why = t("roles.permWhy.overlay");
      break;
    case "frontmatter":
      why = t("roles.permWhy.mode", { mode: reason.startsWith("permissionMode:") ? reason.slice("permissionMode:".length) : mode });
      break;
    case "tools":
      why = reason === "frontmatter:missing" ? t("roles.permWhy.noFrontmatter") : reason === "tools:none" ? t("roles.permWhy.none") : reason === "tools:readOnly" || mode === "readOnly" ? t("roles.permWhy.toolsReadOnly", { tools: role.tools.join(", ") }) : t("roles.permWhy.toolsWrite", { tools: (writes.length ? writes : role.tools).join(", ") });
      break;
    case "allTools":
      why = t("roles.permWhy.allTools");
      break;
    case "ceiling":
      why = t("roles.permission.ceiling");
      break;
    case "overlayCorrupt":
      why = t("roles.permissionSource.overlayCorrupt");
      break;
    case "default":
      why = t("roles.permissionSource.default");
      break;
    default:
      break;
  }
  return { means, ...(why ? { why } : {}), ...(source ? { source: t(`roles.permissionSource.${source}` as MessageKey) } : {}), ceiling: source === "ceiling" };
}

const WARN_KEYS: Record<string, MessageKey> = {
  reserved: "roles.warn.reserved",
  caseClash: "roles.warn.caseClash",
  duplicateName: "roles.warn.duplicateName",
  toolsUnparsable: "roles.warn.toolsUnparsable",
  permissionModeIgnored: "roles.warn.permissionModeIgnored",
  mcpToolsIgnoredForDelegates: "roles.warn.mcpToolsIgnoredForDelegates",
  memoryIgnored: "roles.warn.memoryIgnored",
  effortXhigh: "roles.warn.effortXhigh",
  effortMax: "roles.warn.effortMax",
  effortNotSent: "roles.warn.effortNotSent",
  agentsDirSymlink: "roles.agentsDir.symlink",
};
/** A warning code of the engine in words; an old engine still sends sentences, which show as they are. */
export const warningText = (code: string): string => (code in WARN_KEYS ? t(WARN_KEYS[code]) : code);

const DELETE_CODES = ["confirmDelete", "builtinNoFile", "outsideAgentsDir", "noBackupDir", "readOnly", "testJail", "unknownRole", "overlayCorrupt", "io"] as const;
const DELETE_KEY: Record<(typeof DELETE_CODES)[number], MessageKey> = {
  confirmDelete: "roles.delete.err.confirmDelete",
  builtinNoFile: "roles.delete.err.builtinNoFile",
  outsideAgentsDir: "roles.delete.err.outsideAgentsDir",
  noBackupDir: "roles.delete.err.noBackupDir",
  readOnly: "roles.delete.err.readOnly",
  testJail: "roles.delete.err.testJail",
  unknownRole: "roles.delete.err.unknownRole",
  overlayCorrupt: "roles.delete.err.overlayCorrupt",
  io: "roles.delete.err.io",
};
/** The message of a delete refusal, chosen from the engine's CODE (the engine's own text is only a tooltip). */
export function deleteErrorText(e: unknown): string {
  const code = (e as { code?: string } | null)?.code ?? "";
  return code in DELETE_KEY ? t(DELETE_KEY[code as keyof typeof DELETE_KEY]) : t("roles.deleteFailed");
}

/** Roles that can change files because their own file says so (the one-time "roles now take their permission from their file" notice). */
export const derivedEditors = (groups: readonly RoleGroup[]): string[] =>
  groups.filter((g) => !g.hidden && g.role.canEdit === true && g.role.permission === "edit" && (g.role.permissionSource === "tools" || g.role.permissionSource === "allTools" || g.role.permissionSource === "frontmatter")).map((g) => g.name);

/** The mismatch of one role id, for the bar. */
export const mismatchLabel = (m: PermissionMismatch): string => t("roles.permission.mismatchItem", { name: m.id.split("@")[0], overlay: PERMISSION_TITLES[m.overlay], derived: PERMISSION_TITLES[m.derived] });
