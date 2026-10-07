// The Tauri side of ipc.roles and ipc.runs: maps the wire types of `bindings/roles.ts` (crates/roles) to the
// interfaces the Roles and Runs views use. Kept apart from roles.ts / runs.ts, which only delegate here.
import type { DeletePreview as WireDeletePreview, HistoryEntry, Role as WireRole, RoleDraft, RoleDrift as WireDrift, RoleGroup as WireGroup, RoleProviderCaps as WireCaps, RolesStatus as WireStatus, RunRecord, RunState, UsageSummary } from "../bindings/roles";
import type { AgentEvent } from "../store/agent-types";
import { call } from "./rpc";
import type { DeletePreview, DeleteReport, Role, RoleDrift, RoleGroup, RoleProviderCaps, RolesIpc, RolesStatus } from "./roles";
import type { RewindSnapshot, RunSummary, RunsIpc } from "./runs";
import type { RewindPreview, RewindResult } from "./runsInspect";

const fromWire = (r: WireRole): Role => ({
  id: r.id,
  name: r.name,
  ...(r.description ? { description: r.description } : {}),
  provider: r.provider,
  model: r.model,
  effort: r.effortAvailable ? (r.effort ?? null) : null,
  permission: r.permission,
  tools: r.tools ?? [],
  ...(r.color ? { color: r.color } : {}),
  ...(r.systemPrompt ? { systemPrompt: r.systemPrompt } : {}),
  scope: r.scope,
  ...(r.repoId ? { repoId: r.repoId } : {}),
  repoScope: r.repoScope ?? [],
  remoteStartable: r.remoteStartable ?? false,
  warnings: r.warnings ?? [],
  ...(r.permissionSource ? { permissionSource: r.permissionSource } : {}),
  ...(r.permissionReason ? { permissionReason: r.permissionReason } : {}),
  ...(r.disallowedTools?.length ? { disallowedTools: r.disallowedTools } : {}),
  ...(r.maxTurns ? { maxTurns: r.maxTurns } : {}),
  ...(r.contentHash ? { contentHash: r.contentHash } : {}),
  ...(r.builtin ? { builtin: true } : {}),
  ...(r.canEdit !== undefined ? { canEdit: r.canEdit } : {}),
  ...(r.canRun !== undefined ? { canRun: r.canRun } : {}),
  ...(r.trust ? { trust: r.trust } : {}),
});

const fromWireGroup = (g: WireGroup): RoleGroup => ({
  name: g.name,
  role: fromWire(g.role),
  copies: (g.copies ?? []).map((c) => ({ id: c.id, scope: c.scope, ...(c.repoId ? { repoId: c.repoId } : {}), path: c.path, sameAsWinner: c.sameAsWinner, fieldsDiffer: c.fieldsDiffer, contentHash: c.contentHash, trust: c.trust, ...(c.shadowedByDuplicate ? { shadowedByDuplicate: true } : {}), ...(c.warnings?.length ? { warnings: c.warnings } : {}) })),
  ...(g.winnerId ? { winnerId: g.winnerId } : {}),
  winnerReason: g.winnerReason,
  conflict: g.conflict ?? false,
  ...(g.pin ? { pin: g.pin } : {}),
  pinMissing: g.pinMissing ?? false,
  hidden: g.hidden ?? false,
  builtinShadowed: g.builtinShadowed ?? false,
  diffs: (g.diffs ?? []).map((d: WireDrift): RoleDrift => ({ roleId: d.roleId, fields: d.fields, ...(d.repoId ? { repoId: d.repoId } : {}) })),
  delegate: { ok: g.delegate?.ok ?? true, ...(g.delegate?.reason ? { reason: g.delegate.reason } : {}) },
});

const toDraft = (r: Role): RoleDraft => ({
  id: r.id,
  name: r.name,
  model: r.model,
  description: r.description,
  effort: r.effort ?? undefined,
  tools: r.tools,
  systemPrompt: r.systemPrompt,
  color: r.color,
  scope: r.scope,
  repoId: r.repoId,
  permission: r.permission === "automatic" || r.permission === "bypass" ? undefined : r.permission,
  provider: r.provider,
  repoScope: r.repoScope,
  remoteStartable: r.remoteStartable,
  // Only an explicit choice pins the permission in the overlay; otherwise the engine keeps deriving it from the file.
  ...(r.permissionExplicit ? { permissionExplicit: true } : {}),
} as RoleDraft);

const STATUS: Record<RunState, RunSummary["status"]> = { queued: "running", running: "running", needsYou: "running", done: "done", error: "failed" };

const summary = (r: RunRecord): RunSummary => ({
  id: r.agentId,
  roleId: r.role,
  title: r.title,
  status: STATUS[r.status],
  startedMs: r.startedAt ?? 0,
  repoIds: r.repoIds,
  model: r.model,
  ...(r.forkedFrom ? { forkedFrom: r.forkedFrom } : {}),
  ...(r.sessionId ? { sessionId: r.sessionId } : {}),
  ...(r.tag ? { tag: r.tag } : {}),
  ...(r.note ? { note: r.note } : {}),
});

const fromHistory = (e: HistoryEntry, cost: Map<string, number>): RunSummary => ({
  id: e.id,
  roleId: e.role ?? "",
  title: e.title,
  status: e.status ? STATUS[e.status] : "done",
  startedMs: e.startedAt ?? 0,
  repoIds: e.repoIds,
  ...(e.model ? { model: e.model } : {}),
  ...(cost.has(e.id) ? { costUsd: cost.get(e.id) } : {}),
  ...(e.sessionId ? { sessionId: e.sessionId } : {}),
  ...(e.tag ? { tag: e.tag } : {}),
  source: e.source,
});

export function createBackendRoles(): RolesIpc {
  return {
    list: async () => (await call<WireRole[]>("roles_list")).map(fromWire),
    save: async (role, opts) => fromWire(await call<WireRole>("roles_save", { role: { ...toDraft(role), ...(opts?.confirmWrite ? { confirmWrite: true } : {}) } })),
    async drift() {
      const [drift, roles] = await Promise.all([call<WireDrift[]>("roles_drift"), call<WireRole[]>("roles_list")]);
      const by = (id: string) => roles.find((r) => r.id === id);
      return drift.map((d): RoleDrift => {
        const [global, repo] = [by(d.globalId), by(d.roleId)];
        return { roleId: d.roleId, fields: d.fields, repoId: d.repoId, ...(global ? { global: fromWire(global) } : {}), ...(repo ? { repo: fromWire(repo) } : {}) };
      });
    },
    resolveDrift: (roleId, _repoId, keep, opts) => call<void>("roles_resolve_drift", { roleId, keep, confirmWrite: opts?.confirmWrite ?? false }),
    presetHappyTiering: async (opts) => (await call<WireRole[]>("roles_preset_happy_tiering", { confirmWrite: opts?.confirmWrite ?? false })).map(fromWire),
    capabilities: () => call<WireCaps[]>("roles_capabilities") as Promise<RoleProviderCaps[]>,
    groups: async () => (await call<WireGroup[]>("roles_groups")).map(fromWireGroup),
    setHidden: async (name, hidden) => fromWireGroup(await call<WireGroup>("roles_set_hidden", { name, hidden })),
    setPin: async (name, pin) => fromWireGroup(await call<WireGroup>("roles_set_pin", { name, pin })),
    setTrust: async (name, hash, trusted) => fromWireGroup(await call<WireGroup>("roles_set_trust", { name, hash, trusted })),
    async deletePreview(roleIds): Promise<DeletePreview> {
      const p = await call<WireDeletePreview>("roles_delete_preview", { roleIds });
      return {
        name: p.name,
        files: p.files.map((f) => ({ id: f.id, path: f.path, scope: f.scope, ...(f.repoId ? { repoId: f.repoId } : {}), ...(f.symlinkTarget ? { symlinkTarget: f.symlinkTarget } : {}) })),
        ...(p.backupDir ? { backupDir: p.backupDir } : {}),
        ...(p.linkTarget ? { linkTarget: p.linkTarget } : {}),
      };
    },
    delete: (roleIds, typed, opts) => call<DeleteReport>("roles_delete", { roleIds, typed, ...(opts?.typedLink ? { typedLink: opts.typedLink } : {}) }),
    async status(): Promise<RolesStatus> {
      const st = await call<WireStatus>("roles_status");
      return {
        overlayCorrupt: st.overlayCorrupt,
        ...(st.overlayBackup ? { overlayBackup: st.overlayBackup } : {}),
        mismatches: st.mismatches,
        skippedDirs: st.skippedDirs.map((d) => ({ repoId: d.repoId, path: d.path, code: d.code, ...(d.target ? { target: d.target } : {}) })),
        ...(st.globalDirTarget ? { globalDirTarget: st.globalDirTarget } : {}),
        globalDir: st.globalDir,
      };
    },
    resetOverlay: () => call<void>("roles_reset_overlay"),
    useAutomatic: (roleIds) => call<void>("roles_use_automatic", { roleIds }),
  };
}

export function createBackendRuns(): Omit<RunsIpc, "events" | "rewindPreview"> & {
  events(runId: string): Promise<AgentEvent[]>;
  rewindPreview(runId: string, snapshotId: string): Promise<RewindPreview>;
} {
  const costs = async () => new Map((await call<UsageSummary>("runs_usage")).runs.map((u) => [u.agentId, u.totals.costUsd ?? 0]));
  const rewindPreview = async (runId: string, snapshotId: string): Promise<RewindPreview> => {
    const snaps = await call<{ repoId: string; overwrite: string[]; recreate: string[]; delete: string[] }[]>("runs_rewind_snapshots", { runId });
    const chosen = snaps.filter((s) => !snapshotId || s.repoId === snapshotId);
    return {
      snapshotId,
      files: chosen.flatMap((s) => [
        ...s.overwrite.map((path) => ({ repoId: s.repoId, path, change: "modified" as const })),
        ...s.recreate.map((path) => ({ repoId: s.repoId, path, change: "deleted" as const })),
        ...s.delete.map((path) => ({ repoId: s.repoId, path, change: "created" as const })),
      ]),
    };
  };
  return {
    start: async (req) => summary(await call<RunRecord>("runs_start", { req })),
    list: async () => (await call<RunRecord[]>("runs_list")).map(summary),
    async history(search) {
      const [entries, cost] = await Promise.all([call<HistoryEntry[]>("runs_history", { query: { search: search || undefined } }), costs()]);
      return entries.map((e) => fromHistory(e, cost));
    },
    resume: async (id) => summary(await call<RunRecord>("runs_resume", { id })),
    fork: async (id) => summary(await call<RunRecord>("runs_fork", { id })),
    async rewindSnapshots(runId): Promise<RewindSnapshot[]> {
      const snaps = await call<{ repoId: string; takenAt: number | null; files: number | null }[]>("runs_rewind_snapshots", { runId });
      // takenAt is Unix seconds (the snapshot's commit time); the dialog wants milliseconds
      return snaps.map((s) => ({ id: s.repoId, repoId: s.repoId, takenMs: s.takenAt == null ? 0 : s.takenAt < 1e11 ? s.takenAt * 1000 : s.takenAt, label: `${s.files ?? 0} files before the run` }));
    },
    async rewindRestore(runId, opts): Promise<RewindResult> {
      const preview = await rewindPreview(runId, opts.snapshotId ?? "");
      await call<void>("runs_rewind_restore", { runId, confirm: opts.confirm, repoId: opts.snapshotId });
      return { snapshotId: preview.snapshotId, restored: preview.files };
    },
    events: (runId) => call<AgentEvent[]>("agent_history", { agentId: runId }),
    rewindPreview,
  };
}
