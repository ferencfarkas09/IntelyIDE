import type { PermissionMismatch, Role, RoleCopy, RoleDrift, RoleGroup, RoleProviderCaps, RolesIpc, WinnerReason } from "../roles";

const READ = ["Read", "Grep", "Glob"];
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-4-5-20251001";
const OPUS = "claude-opus-5-5";

const CAPS: RoleProviderCaps[] = [
  {
    provider: "claude",
    label: "Claude",
    models: [
      { id: HAIKU, label: "Haiku 4.5", effortLevels: [] },
      { id: SONNET, label: "Sonnet 5.5", effortLevels: ["low", "medium", "high"] },
      { id: OPUS, label: "Opus 5.5", effortLevels: ["low", "medium", "high", "xhigh", "max"] },
    ],
    permissionModes: ["readOnly", "edit", "ask"],
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "WebFetch", "Task"],
  },
  // Placeholder model ids: the real lists come from listModels() per adapter, which only exists once the adapter does.
  {
    provider: "codex",
    label: "Codex",
    models: [
      { id: "codex-default", label: "Codex default", effortLevels: ["low", "medium", "high"] },
      { id: "codex-mini", label: "Codex mini", effortLevels: [] },
    ],
    permissionModes: ["readOnly", "edit", "ask"],
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
  },
  {
    provider: "gemini",
    label: "Gemini",
    models: [
      { id: "gemini-pro", label: "Gemini Pro", effortLevels: ["low", "medium", "high"] },
      { id: "gemini-flash", label: "Gemini Flash", effortLevels: [] },
    ],
    permissionModes: ["readOnly", "edit", "ask"],
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "WebFetch"],
  },
  {
    provider: "copilot",
    label: "GitHub Copilot",
    models: [{ id: "copilot-default", label: "Copilot default", effortLevels: ["low", "medium", "high"] }],
    permissionModes: ["readOnly", "edit", "ask"],
    tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
  },
];

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "WebSearch", "WebFetch", "TodoWrite"]);
const OVERLAY_DIR = "~/Library/Application Support/IntelySwitchIDE";
const BACKUP_DIR = `${OVERLAY_DIR}/role-backups`;
const REPO_PATH: Record<string, string> = { admin: "~/Projects/admin", backend: "~/Projects/shop-backend", services: "~/Projects/shop-mobile", pos: "~/WebstormProjects/shop-pos" };

/** Files of the global agents directory. `researcher` has no file: it is the built-in of that name. */
const SEED: Role[] = [
  { id: "developer", name: "developer", description: "Implements and fixes code", provider: "claude", model: SONNET, effort: "medium", permission: "edit", tools: [...READ, "Edit", "Write", "Bash"], color: "#4caf7d", defaultRepoIds: ["admin"] },
  { id: "reviewer", name: "reviewer", description: "Reads a change and reports findings", provider: "claude", model: SONNET, effort: "high", permission: "edit", tools: [...READ, "Bash"], color: "#3b9ae8", defaultRepoIds: ["admin", "backend"] },
  { id: "architect", name: "architect", description: "Designs larger changes, asks before acting", provider: "claude", model: OPUS, effort: "high", permission: "ask", tools: [...READ, "Task"], color: "#8b6cf0", defaultRepoIds: ["backend"] },
  { id: "scribe", name: "scribe", description: "Writes release notes", provider: "claude", model: HAIKU, effort: null, permission: "readOnly", tools: READ, color: "#c26fb0" },
];
const BUILTIN: Role = { id: "researcher", name: "researcher", description: "Read-only lookup across repos", provider: "claude", model: HAIKU, effort: null, permission: "readOnly", tools: READ, color: "#f0a23a", defaultRepoIds: ["backend", "admin", "services", "pos"], builtin: true, scope: "global", trust: "trusted", permissionSource: "default", canEdit: false, canRun: false };

/** The Happy tiering: Haiku looks things up, Sonnet writes and reviews, Opus plans. */
const TIERING: Role[] = SEED.map((r) => ({ ...r }));

/** The copy of `developer` kept in the admin repo drifted: a heavier model and no Bash. */
const REPO_DEVELOPER: Role = { ...SEED[0], model: OPUS, effort: "high", tools: [...READ, "Edit", "Write"] };
/** A repository ships its own role: nobody approved it yet. */
const REPO_ONLY: Role = { id: "deploy-helper", name: "deploy-helper", description: "Runs the deploy checklist of this repository", provider: "claude", model: SONNET, effort: "medium", permission: "edit", tools: [...READ, "Bash", "Edit"], color: "#d9534f" };

const FIELDS: (keyof Role)[] = ["name", "description", "provider", "model", "effort", "permission", "tools", "color", "defaultRepoIds", "systemPrompt"];
const HASHED: (keyof Role)[] = ["description", "provider", "model", "effort", "tools", "color", "systemPrompt"];
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const differing = (a: Role, b: Role) => FIELDS.filter((f) => !same(a[f], b[f]));
const hashOf = (r: Role) => `h${[...JSON.stringify(HASHED.map((f) => (f === "tools" ? [...r.tools].sort() : r[f] ?? null)))].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16)}`;
const RANK = { readOnly: 0, ask: 1, edit: 2, automatic: 3, bypass: 4 } as const;

export interface MockRolesOptions {
  /** 0.1.0 pinned every saved role read-only: the migration bar. */
  mismatch?: boolean;
  /** The overlay file cannot be parsed: every role is read-only and the repair notice shows. */
  corrupt?: boolean;
  /** A repository's agents folder is a link (skipped) and the global one is a link too. */
  symlink?: boolean;
}

interface Entry {
  role: Role;
  repoId?: string;
}

export function createMockRoles(options: MockRolesOptions = {}): RolesIpc {
  const params = new URLSearchParams(globalThis.location?.search);
  const mismatch = options.mismatch ?? params.has("mismatch");
  let corrupt = options.corrupt ?? params.has("corrupt");
  const symlinked = options.symlink ?? params.has("symlink");
  const globalLink = symlinked ? "/Users/me/dotfiles/claude/agents" : undefined;
  let globals: Role[] = structuredClone(SEED);
  /** key = `name@repoId` */
  let repoCopies: Record<string, Entry> = {
    "developer@admin": { role: structuredClone(REPO_DEVELOPER), repoId: "admin" },
    "developer@backend": { role: structuredClone(SEED[0]), repoId: "backend" },
    "deploy-helper@services": { role: structuredClone(REPO_ONLY), repoId: "services" },
  };
  const hidden = new Set<string>(["scribe"]);
  const pins = new Map<string, string>();
  const approved = new Set<string>();
  /** Roles whose permission the user pinned in the overlay (id -> mode). */
  const pinned = new Map<string, Role["permission"]>(mismatch ? [["developer", "readOnly"], ["reviewer", "readOnly"]] : []);

  const derive = (r: Role, repo: boolean, trusted: boolean): Role => {
    const writes = r.tools.some((x) => !READ_TOOLS.has(x) && x !== "Task");
    const canEdit = r.tools.some((x) => x === "Edit" || x === "Write" || x === "NotebookEdit");
    const canRun = r.tools.includes("Bash");
    let permission = r.permission ?? "readOnly";
    let source: Role["permissionSource"] = "tools";
    let reason = writes ? "tools:write" : "tools:readOnly";
    if (r.id === "architect") {
      permission = "ask";
      source = "overlay";
      reason = "overlay";
    } else if (pinned.has(r.id)) {
      permission = pinned.get(r.id)!;
      source = "overlay";
      reason = "overlay";
    } else permission = writes ? "edit" : "readOnly";
    if (corrupt) {
      permission = "readOnly";
      source = "overlayCorrupt";
      reason = "overlayCorrupt";
    } else if (repo && !trusted && source !== "overlay" && RANK[permission] > RANK.ask) {
      permission = "ask";
      source = "ceiling";
      reason = "ceiling";
    }
    return { ...r, permission, permissionSource: source, permissionReason: reason, canEdit, canRun, trust: !repo ? "trusted" : trusted ? (approved.has(hashOf(r)) ? "approved" : "trusted") : "untrusted", contentHash: hashOf(r), scope: repo ? "repo" : "global", ...(r.builtin ? { builtin: true } : {}) };
  };

  const copiesOf = (name: string): { global?: Role; repos: Entry[] } => ({
    global: globals.find((r) => r.name === name),
    repos: Object.values(repoCopies).filter((e) => e.role.name === name),
  });
  const names = (): string[] => [...new Set([...globals.map((r) => r.name), ...Object.values(repoCopies).map((e) => e.role.name), BUILTIN.name])].sort();

  const build = (name: string): RoleGroup => {
    const { global, repos } = copiesOf(name);
    const builtin = name === BUILTIN.name && !global ? BUILTIN : undefined;
    const globalHash = global ? hashOf(global) : undefined;
    const trustedRepo = (e: Entry) => e.role.name && (hashOf(e.role) === globalHash || approved.has(hashOf(e.role)));
    const entries: { id: string; role: Role; repoId?: string; trusted: boolean }[] = [
      ...(global ? [{ id: global.id, role: global, trusted: true }] : []),
      ...repos.map((e) => ({ id: `${name}@${e.repoId}`, role: e.role, repoId: e.repoId, trusted: !!trustedRepo(e) })),
    ];
    const usable = entries.filter((e) => e.trusted);
    const pool = usable.length > 0 ? usable : entries;
    const pin = pins.get(name);
    const pinned = pin ? entries.find((e) => (pin === "global" ? !e.repoId : e.repoId === pin.slice(5))) : undefined;
    const hashes = new Set(entries.map((e) => hashOf(e.role)));
    let winner = pinned ?? pool[0];
    let reason: WinnerReason = "onlyCopy";
    let conflict = false;
    if (pinned) reason = "pinned";
    else if (entries.length === 0) reason = "builtIn";
    else if (entries.length === 1) reason = "onlyCopy";
    else if (hashes.size === 1) {
      winner = pool.find((e) => !e.repoId) ?? pool[0];
      reason = "identical";
    } else if (pool.some((e) => !e.repoId)) {
      winner = pool.find((e) => !e.repoId)!;
      reason = "global";
      conflict = true;
    } else {
      reason = "primaryRepo";
      conflict = true;
    }
    const winnerRole = winner ? derive(winner.role, !!winner.repoId, winner.trusted) : derive(builtin ?? BUILTIN, false, true);
    const winnerHash = winner ? hashOf(winner.role) : undefined;
    const copies: RoleCopy[] = entries.map((e) => ({
      id: e.id,
      scope: e.repoId ? "repo" : "global",
      ...(e.repoId ? { repoId: e.repoId } : {}),
      path: `${e.repoId ? REPO_PATH[e.repoId] : "~"}/.claude/agents/${name}.md`,
      sameAsWinner: hashOf(e.role) === winnerHash,
      fieldsDiffer: winner && hashOf(e.role) !== winnerHash ? differing(winner.role, e.role).filter((f) => HASHED.includes(f)) : [],
      contentHash: hashOf(e.role),
      trust: e.repoId ? (e.trusted ? (approved.has(hashOf(e.role)) ? "approved" : "trusted") : "untrusted") : "trusted",
    }));
    const untrustedOnly = usable.length === 0 && entries.length > 0;
    const diffs: RoleDrift[] = copies.filter((c) => !c.sameAsWinner).map((c) => ({ roleId: c.id, repoId: c.repoId, fields: c.fieldsDiffer }));
    return {
      name,
      role: winnerRole,
      copies,
      ...(winner ? { winnerId: winner.id } : {}),
      winnerReason: reason,
      conflict,
      ...(pin ? { pin } : {}),
      pinMissing: !!pin && !pinned,
      hidden: hidden.has(name),
      builtinShadowed: !!global && name === BUILTIN.name,
      diffs,
      delegate: hidden.has(name) ? { ok: false, reason: "hidden" } : untrustedOnly ? { ok: false, reason: "untrusted" } : { ok: true },
    };
  };

  const driftList = (): RoleDrift[] => names().flatMap((n) => build(n).diffs.filter((d) => d.repoId));
  const group = (name: string): RoleGroup => build(name);
  const mismatchList = async (): Promise<PermissionMismatch[]> =>
    [...pinned.entries()].flatMap(([id, overlay]) => {
      const r = globals.find((g) => g.id === id);
      const derived = r ? derive({ ...r, id: `${id}~` }, false, true).permission : undefined;
      return r && derived && derived !== overlay ? [{ id, overlay: overlay!, derived, reason: "tools:write" }] : [];
    });

  return {
    list: async () => [...globals.map((r) => derive(r, false, true)), ...Object.entries(repoCopies).map(([key, e]) => ({ ...derive(e.role, true, false), id: key, repoId: e.repoId }))].map((r) => structuredClone(r)),
    groups: async () => names().map(build).map((g) => structuredClone(g)),
    capabilities: async () => structuredClone(CAPS),
    async setHidden(name, value) {
      if (value) hidden.add(name);
      else hidden.delete(name);
      return structuredClone(group(name));
    },
    async setPin(name, pin) {
      if (pin === null) pins.delete(name);
      else pins.set(name, pin);
      return structuredClone(group(name));
    },
    async setTrust(name, hash, trusted) {
      if (trusted) approved.add(hash);
      else approved.delete(hash);
      return structuredClone(group(name));
    },
    async deletePreview(roleIds) {
      return {
        name: roleIds[0]?.split("@")[0] ?? "",
        ...(globalLink ? { linkTarget: globalLink } : {}),
        files: roleIds.flatMap((id) => {
          const c = names().flatMap((n) => build(n).copies).find((x) => x.id === id);
          return c ? [{ id, path: c.path, scope: c.scope, ...(c.repoId ? { repoId: c.repoId } : {}) }] : [];
        }),
        backupDir: BACKUP_DIR,
      };
    },
    async status() {
      return {
        overlayCorrupt: corrupt,
        ...(corrupt ? { overlayBackup: `${OVERLAY_DIR}/roles-overlay.json.bak` } : {}),
        mismatches: corrupt ? [] : await mismatchList(),
        skippedDirs: symlinked ? [{ repoId: "pos", path: `${REPO_PATH.pos}/.claude/agents`, code: "agentsDirSymlink", target: "/Volumes/shared/agents" }] : [],
        ...(globalLink ? { globalDirTarget: globalLink } : {}),
        globalDir: "~/.claude/agents",
      };
    },
    async resetOverlay() {
      corrupt = false;
    },
    async delete(roleIds, typed) {
      const all = names().flatMap((n) => build(n).copies);
      const targets = roleIds.map((id) => all.find((c) => c.id === id));
      if (targets.some((c) => !c)) throw { code: roleIds.some((id) => id === BUILTIN.name) ? "builtinNoFile" : "unknownRole", message: "No such role file" };
      if (typed !== roleIds[0].split("@")[0]) throw { code: "confirmDelete", message: "Type the role name to confirm" };
      for (const id of roleIds) {
        if (repoCopies[id]) {
          const { [id]: _drop, ...rest } = repoCopies;
          repoCopies = rest;
        } else globals = globals.filter((r) => r.id !== id);
      }
      return { deleted: targets.map((c) => ({ id: c!.id, path: c!.path })), backups: targets.map((c) => `${BACKUP_DIR}/${c!.id}.md.bak`) };
    },
    async useAutomatic(roleIds) {
      roleIds.forEach((id) => pinned.delete(id));
    },
    async save(role) {
      const caps = CAPS.find((c) => c.provider === (role.provider ?? CAPS[0].provider));
      const model = caps?.models.find((m) => m.id === role.model);
      if (!caps || !model) throw { code: "invalidSelection", message: `Model ${role.model} is not offered by ${role.provider}` };
      if (role.effort && !model.effortLevels.includes(role.effort)) throw { code: "invalidSelection", message: `${model.label} has no ${role.effort} effort` };
      if (["auto", "explore", "plan", "probe", "fork", "general-purpose", "statusline-setup"].includes(role.name.toLowerCase())) throw { code: "reservedName", message: `${role.name} is reserved` };
      if (corrupt) throw { code: "overlayCorrupt", message: "The overlay file is damaged" };
      const { permissionExplicit, ...plain } = role;
      if (permissionExplicit && role.permission) pinned.set(role.id, role.permission);
      const stored = { ...plain };
      globals = globals.some((r) => r.id === role.id) ? globals.map((r) => (r.id === role.id ? structuredClone(stored) : r)) : [...globals, structuredClone(stored)];
      return structuredClone(derive(stored, false, true));
    },
    drift: async () => driftList(),
    async resolveDrift(roleId, repoId, keep) {
      const entry = repoCopies[roleId] ?? repoCopies[`${roleId}@${repoId}`];
      const key = repoCopies[roleId] ? roleId : `${roleId}@${repoId}`;
      if (!entry) throw { code: "invalidSelection", message: `No repo copy of ${roleId} in ${repoId}` };
      const name = entry.role.name;
      if (keep === "repo") globals = globals.map((r) => (r.name === name ? { ...structuredClone(entry.role), id: name } : r));
      else repoCopies[key] = { ...entry, role: { ...structuredClone(globals.find((r) => r.name === name)!), id: entry.role.id } };
      if (keep === "repo") {
        const { [key]: _drop, ...rest } = repoCopies;
        repoCopies = rest;
      }
    },
    async presetHappyTiering() {
      globals = structuredClone(TIERING);
      repoCopies = {};
      return structuredClone(globals);
    },
  };
}
