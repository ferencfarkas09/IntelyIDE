import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: [string, unknown][] = [];
const replies = new Map<string, unknown>();
vi.mock("./rpc", () => ({
  call: async (cmd: string, args?: unknown) => {
    calls.push([cmd, args]);
    return replies.get(cmd);
  },
}));

import { createBackendRoles, createBackendRuns } from "./rolesBackend";

const wireRole = (over: object = {}) => ({
  id: "researcher", name: "researcher", model: "haiku", effort: "low", effortAvailable: false, tools: ["Read"], scope: "global", path: "/x.md",
  permission: "readOnly", provider: "claude", repoScope: [], remoteStartable: false, warnings: [], ...over,
});

beforeEach(() => {
  calls.length = 0;
  replies.clear();
});

describe("roles backend", () => {
  it("shows effort as n/a when the model has none and saves a draft that leaves unknown fields out", async () => {
    replies.set("roles_list", [wireRole(), wireRole({ id: "dev", name: "dev", model: "sonnet", effort: "medium", effortAvailable: true })]);
    const roles = await createBackendRoles().list();
    expect(roles.map((r) => r.effort)).toEqual([null, "medium"]);
    replies.set("roles_save", wireRole());
    await createBackendRoles().save({ id: "researcher", name: "researcher", model: "haiku", effort: null, tools: ["Read"], permission: "readOnly" });
    const draft = (calls.at(-1)![1] as { role: Record<string, unknown> }).role;
    expect(draft).toMatchObject({ name: "researcher", permission: "readOnly" });
    expect(draft.effort).toBeUndefined();
    expect(draft.memory).toBeUndefined();
  });

  it("joins drift with the roles of both sides", async () => {
    replies.set("roles_drift", [{ roleId: "dev@r1", globalId: "dev", repoId: "r1", fields: ["model"] }]);
    replies.set("roles_list", [wireRole({ id: "dev", name: "dev" }), wireRole({ id: "dev@r1", name: "dev", scope: "repo", repoId: "r1" })]);
    const [d] = await createBackendRoles().drift();
    expect(d).toMatchObject({ roleId: "dev@r1", repoId: "r1", fields: ["model"] });
    expect(d.global?.id).toBe("dev");
    expect(d.repo?.id).toBe("dev@r1");
  });
});

describe("roles backend: groups, hide, pin, trust, delete", () => {
  const wireGroup = (over: object = {}) => ({
    name: "developer",
    role: wireRole({ id: "developer", name: "developer", permission: "edit", permissionSource: "tools", permissionReason: "tools:write", canEdit: true, canRun: true, trust: "trusted", contentHash: "h1" }),
    copies: [
      { id: "developer", scope: "global", path: "~/.claude/agents/developer.md", sameAsWinner: true, fieldsDiffer: [] },
      { id: "developer@admin", scope: "repo", repoId: "admin", path: "/r/admin/.claude/agents/developer.md", sameAsWinner: false, fieldsDiffer: ["model", "tools"] },
    ],
    winnerId: "developer",
    winnerReason: "global",
    conflict: true,
    pinMissing: false,
    hidden: false,
    builtinShadowed: false,
    diffs: [{ roleId: "developer@admin", globalId: "developer", repoId: "admin", fields: ["model", "tools"] }],
    delegate: { ok: true },
    ...over,
  });

  it("maps a wire group: the winner with its derivation, the copies and what differs", async () => {
    replies.set("roles_groups", [wireGroup(), wireGroup({ name: "x", pin: "repo:admin", hidden: true, delegate: { ok: false, reason: "hidden" } })]);
    const [g, h] = await createBackendRoles().groups();
    expect(g).toMatchObject({ name: "developer", winnerReason: "global", conflict: true, hidden: false });
    expect(g.role).toMatchObject({ permission: "edit", permissionSource: "tools", permissionReason: "tools:write", canEdit: true, canRun: true, trust: "trusted" });
    expect(g.copies.map((c) => [c.id, c.sameAsWinner])).toEqual([["developer", true], ["developer@admin", false]]);
    expect(g.diffs).toEqual([{ roleId: "developer@admin", repoId: "admin", fields: ["model", "tools"] }]);
    expect(h).toMatchObject({ pin: "repo:admin", hidden: true, delegate: { ok: false, reason: "hidden" } });
  });

  it("sends hide, pin, trust and delete with the exact command arguments and keeps the typed name", async () => {
    replies.set("roles_set_hidden", wireGroup({ hidden: true }));
    replies.set("roles_set_pin", wireGroup({ pin: "global" }));
    replies.set("roles_set_trust", wireGroup());
    replies.set("roles_delete_preview", { files: [{ id: "developer@admin", path: "/p", scope: "repo", repoId: "admin" }], backupDir: "/b" });
    replies.set("roles_delete", { deleted: [{ id: "developer@admin", path: "/p" }], backups: ["/b/x"] });
    const roles = createBackendRoles();
    expect((await roles.setHidden("developer", true)).hidden).toBe(true);
    expect((await roles.setPin("developer", "global")).pin).toBe("global");
    await roles.setTrust("developer", "h9", true);
    await roles.deletePreview(["developer@admin"]);
    const report = await roles.delete(["developer@admin"], "developer");
    expect(report.backups).toEqual(["/b/x"]);
    expect(calls.map(([c, a]) => [c, a])).toEqual([
      ["roles_set_hidden", { name: "developer", hidden: true }],
      ["roles_set_pin", { name: "developer", pin: "global" }],
      ["roles_set_trust", { name: "developer", hash: "h9", trusted: true }],
      ["roles_delete_preview", { roleIds: ["developer@admin"] }],
      ["roles_delete", { roleIds: ["developer@admin"], typed: "developer" }],
    ]);
  });

  it("pins the permission only when the editor says the user chose it", async () => {
    replies.set("roles_save", wireRole());
    const roles = createBackendRoles();
    const base = { id: "researcher", name: "researcher", model: "haiku", effort: null, tools: ["Read"], permission: "readOnly" as const };
    await roles.save(base);
    expect((calls.at(-1)![1] as { role: Record<string, unknown> }).role.permissionExplicit).toBeUndefined();
    await roles.save({ ...base, permissionExplicit: true });
    expect((calls.at(-1)![1] as { role: Record<string, unknown> }).role.permissionExplicit).toBe(true);
  });

  it("reads no mismatches from an engine that cannot tell, and removes the overlay permission by id", async () => {
    const roles = createBackendRoles();
    replies.set("roles_use_automatic", undefined);
    await roles.useAutomatic(["developer", "reviewer"]);
    expect(calls.at(-1)).toEqual(["roles_use_automatic", { roleIds: ["developer", "reviewer"] }]);
  });
});

describe("runs backend", () => {
  const record = (over: object = {}) => ({ agentId: "a-1", role: "developer", model: "m", cwd: "/r", repoIds: ["r"], startedAt: 5, status: "needsYou", title: "t", ...over });

  it("maps run records to summaries (a queued run reports running with its note)", async () => {
    replies.set("runs_list", [record(), record({ agentId: "q-1", status: "queued", note: "waiting for a-1" }), record({ agentId: "a-2", status: "error" })]);
    const list = await createBackendRuns().list();
    expect(list.map((r) => [r.id, r.status])).toEqual([["a-1", "running"], ["q-1", "running"], ["a-2", "failed"]]);
    expect(list[1].note).toBe("waiting for a-1");
  });

  it("history joins the cost estimate and keeps external sessions apart", async () => {
    replies.set("runs_history", [{ id: "a-1", role: "developer", title: "t", source: "ide", repoIds: ["r"], startedAt: 1, lastModified: 2, status: "done" }, { id: "session:s", title: "x", source: "external", repoIds: [], startedAt: 1, lastModified: 3 }]);
    replies.set("runs_usage", { runs: [{ agentId: "a-1", totals: { costUsd: 0.5 } }], total: {} });
    const rows = await createBackendRuns().history("fix");
    expect(calls.find(([c]) => c === "runs_history")![1]).toEqual({ query: { search: "fix" } });
    expect(rows.map((r) => [r.id, r.costUsd, r.source])).toEqual([["a-1", 0.5, "ide"], ["session:s", undefined, "external"]]);
  });

  it("previews and restores a snapshot per repo, with the confirmation passed on", async () => {
    replies.set("runs_rewind_snapshots", [{ repoId: "r", takenAt: 9, files: 3, overwrite: ["a"], recreate: ["b"], delete: ["c"] }]);
    const runs = createBackendRuns();
    expect((await runs.rewindSnapshots("a-1")).map((x) => x.takenMs)).toEqual([9000]);
    expect((await runs.rewindPreview("a-1", "r")).files.map((f) => [f.path, f.change])).toEqual([["a", "modified"], ["b", "deleted"], ["c", "created"]]);
    await runs.rewindRestore("a-1", { confirm: true, snapshotId: "r" });
    expect(calls.at(-1)).toEqual(["runs_rewind_restore", { runId: "a-1", confirm: true, repoId: "r" }]);
  });
});
