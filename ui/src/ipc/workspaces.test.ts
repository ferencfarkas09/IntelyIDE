import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoConfig } from "../bindings";
import { createMockWorkspaces, issueMockToken, MOCK_REGISTRY_KEY, type MockWorkspaces } from "./mock/workspaces";
import { createMockIpc } from "./mock";

const cfg = (id: string, path: string, order = 0): RepoConfig => ({ id, path, name: id, color: "#4caf7d", badge: id.slice(0, 2).toUpperCase(), order, pushTargets: {} });
const SEED = [cfg("backend", "/p/backend"), cfg("admin", "/p/admin", 1)];

class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

const code = async (p: Promise<unknown>): Promise<string | undefined> => p.then(() => undefined, (e: { code: string }) => e.code);

describe("mock workspaces registry", () => {
  let ws: MockWorkspaces;
  beforeEach(() => {
    ws = createMockWorkspaces({ seed: SEED, now: () => 1_000_000 });
  });

  it("seeds the migrated workspace as the open one", async () => {
    const v = await ws.list();
    expect(v.activeId).toBe("w-migrated");
    expect(v.workspaces.map((w) => w.name)).toEqual(["Happy workspace", "Side projects", "Client X"]);
    expect(v.workspaces[0].repos.map((r) => r.id)).toEqual(["backend", "admin"]);
    expect(ws.activeWorkspace()?.repos).toHaveLength(2);
  });

  it("the welcome scenario has no workspace", async () => {
    const v = await createMockWorkspaces({ scenario: "welcome" }).list();
    expect(v.activeId).toBeNull();
    expect(v.workspaces).toEqual([]);
  });

  it("create redeems tokens, derives ids and rejects a used token", async () => {
    const token = issueMockToken({ path: "/p/new-repo" });
    const r = await ws.create({ name: "  Fresh  ", repos: [{ token }] });
    expect(r.reused).toBe(false);
    expect(r.entry.name).toBe("Fresh");
    const created = (await ws.list()).workspaces.find((w) => w.id === r.entry.id)!;
    expect(created.repos[0].id).toMatch(/^new-repo-[0-9a-f]{10}$/);
    expect(created.repos[0].badge).toBe("NR");
    expect(await code(ws.create({ name: "Again", repos: [{ token }] }))).toBe("tokenUsed");
  });

  it("an unknown token is expired, a wrong purpose is refused, an expired one too", async () => {
    expect(await code(ws.create({ name: "A", repos: [{ token: "nope" }] }))).toBe("tokenExpired");
    const wrong = issueMockToken({ path: "/p/x" }, "scanRoot");
    expect(await code(ws.create({ name: "A", repos: [{ token: wrong }] }))).toBe("wrongPurpose");
    let now = 0;
    const clock = createMockWorkspaces({ seed: SEED, now: () => now });
    const old = issueMockToken({ path: "/p/y" }, "workspaceRepo", 0);
    now = 6 * 60_000;
    expect(await code(clock.create({ name: "A", repos: [{ token: old }] }))).toBe("tokenExpired");
  });

  it("a risky repository needs trust: true", async () => {
    expect(await code(ws.create({ name: "R", repos: [{ token: "mock-risky:/p/risky" }] }))).toBe("trustRequired");
    const r = await ws.create({ name: "R", repos: [{ token: "mock-risky:/p/risky", trust: true }] });
    expect(r.reused).toBe(false);
  });

  it("the same folder set reuses the existing workspace", async () => {
    const r = await ws.create({ name: "Other name", repos: [{ token: "mock:/p/backend" }, { token: "mock:/p/admin" }] });
    expect(r.reused).toBe(true);
    expect(r.entry.id).toBe("w-migrated");
    expect((await ws.list()).workspaces).toHaveLength(3);
  });

  it("an existing repo id is reused by identity", async () => {
    const r = await ws.create({ name: "Mixed", repos: [{ token: "mock:/p/backend" }, { token: "mock:/p/extra" }] });
    const created = (await ws.list()).workspaces.find((w) => w.id === r.entry.id)!;
    expect(created.repos[0].id).toBe("backend");
    expect(created.repos[1].id).not.toBe("backend");
  });

  it("name rules: empty, 61 characters, control and format characters, duplicates ignoring case and NFC", async () => {
    expect(await code(ws.rename("w3f9a1c2b4", "   "))).toBe("invalidName");
    expect(await code(ws.rename("w3f9a1c2b4", "x".repeat(61)))).toBe("invalidName");
    expect(await code(ws.rename("w3f9a1c2b4", "a‮b"))).toBe("invalidName");
    expect(await code(ws.rename("w3f9a1c2b4", "a\u0007b"))).toBe("invalidName");
    expect(await code(ws.rename("w3f9a1c2b4", "HAPPY workspace"))).toBe("duplicateName");
    expect((await ws.rename("w3f9a1c2b4", "Café")).name).toBe("Café");
    expect(await code(ws.rename("w7c1d2e3f4", "Café"))).toBe("duplicateName");
    expect((await ws.rename("w3f9a1c2b4", "Side projects")).name).toBe("Side projects");
  });

  it("colour rules", async () => {
    expect(await code(ws.recolor("w3f9a1c2b4", "red"))).toBe("invalidColor");
    expect((await ws.recolor("w3f9a1c2b4", "#AABBCC")).color).toBe("#aabbcc");
  });

  it("duplicate copies the repos and gives a unique name", async () => {
    const a = await ws.duplicate("w-migrated");
    const b = await ws.duplicate("w-migrated");
    expect([a.name, b.name]).toEqual(["Happy workspace copy", "Happy workspace copy (2)"]);
    expect(a.lastOpenedAt).toBeNull();
    expect((await ws.list()).workspaces.find((w) => w.id === a.id)!.repos).toHaveLength(2);
  });

  it("remove needs confirm, refuses the active workspace and keeps nothing on disk to delete", async () => {
    expect(await code(ws.remove("w3f9a1c2b4", false))).toBe("confirmRequired");
    expect(await code(ws.remove("w-migrated", true))).toBe("workspaceActive");
    await ws.remove("w3f9a1c2b4", true);
    expect((await ws.list()).workspaces.map((w) => w.id)).toEqual(["w-migrated", "w7c1d2e3f4"]);
    expect(await code(ws.remove("w3f9a1c2b4", true))).toBe("workspaceNotFound");
  });

  it("reorder needs exactly the known ids", async () => {
    await ws.reorder(["w7c1d2e3f4", "w-migrated", "w3f9a1c2b4"]);
    expect((await ws.list()).workspaces.map((w) => w.id)).toEqual(["w7c1d2e3f4", "w-migrated", "w3f9a1c2b4"]);
    expect(await code(ws.reorder(["w-migrated"]))).toBe("workspaceNotFound");
  });

  it("limits", async () => {
    const many = createMockWorkspaces({ seed: SEED });
    for (let i = 0; i < 197; i++) await many.duplicate("w-migrated", `n${i}`);
    expect(await code(many.duplicate("w-migrated", "one too many"))).toBe("limitReached");
  });

  it("switch: events, epoch, lastOpenedAt, gate until ready", async () => {
    const seen: string[] = [];
    ws.onSwitching((e) => seen.push(`switching ${e.fromId}>${e.toId}@${e.epoch}`));
    ws.onChanged((e) => seen.push(`changed ${e.activeId}@${e.epoch}`));
    const r = await ws.switch("w3f9a1c2b4", { force: false });
    expect(r).toMatchObject({ activeId: "w3f9a1c2b4", epoch: 2, warnings: [], survivors: [] });
    expect(seen).toEqual(["switching w-migrated>w3f9a1c2b4@2", "changed w3f9a1c2b4@2"]);
    expect(ws.activeEntry()?.lastOpenedAt).toBe(1_000_000);
    expect(ws.gateSet()).toBe(true);
    expect(await code(ws.switch(null, { force: false }))).toBe("workspaceSwitching");
    expect(await code(ws.ready(1))).toBe("staleEpoch");
    await ws.ready(2);
    expect(ws.gateSet()).toBe(false);
    await ws.switch(null, { force: false });
    expect(ws.activeWorkspace()).toBeNull();
  });

  it("switch to an unknown or damaged workspace changes nothing", async () => {
    expect(await code(ws.switch("w-nope", { force: true }))).toBe("workspaceNotFound");
    expect(ws.epoch()).toBe(1);
    expect(ws.activeEntry()?.id).toBe("w-migrated");
  });

  it("busy: blocking always refuses, confirmable only without force and is stopped by a forced switch", async () => {
    const stopped = vi.fn();
    ws.onStopped(stopped);
    ws.setBusy({ blocking: [{ kind: "gitRun", count: 1, labels: ["push"] }], confirmable: [] });
    const blocked = await ws.switch("w3f9a1c2b4", { force: true }).catch((e: { code: string; detail: string }) => e);
    expect((blocked as { code: string }).code).toBe("workspaceBusy");
    expect(JSON.parse((blocked as { detail: string }).detail).blocking[0].kind).toBe("gitRun");
    ws.setBusy({ blocking: [], confirmable: [{ kind: "devServer", count: 2, labels: ["api", "web"] }] });
    expect(await code(ws.switch("w3f9a1c2b4", { force: false }))).toBe("workspaceBusy");
    await ws.switch("w3f9a1c2b4", { force: true });
    expect(stopped).toHaveBeenCalledOnce();
    expect(await ws.busy()).toEqual({ blocking: [], confirmable: [] });
  });

  it("keepActive detaches without changing activeId", async () => {
    const r = await ws.switch(null, { force: true, keepActive: true });
    expect(r.activeId).toBe("w-migrated");
    expect((await ws.list()).activeId).toBe("w-migrated");
  });

  it("survivors are listed and only those can be killed", async () => {
    ws.setSurvivors([{ pid: 4242, port: 3000, cwd: "/p/backend", kind: "devServer" }]);
    const r = await ws.switch("w3f9a1c2b4", { force: true });
    expect(r.survivors).toHaveLength(1);
    expect(await code(ws.killSurvivor(1))).toBe("notFound");
    await ws.killSurvivor(4242);
    expect(await code(ws.killSurvivor(4242))).toBe("notFound");
  });

  it("probe reports statuses and branches without touching the registry", async () => {
    ws.setProbe("/p/admin", "missing");
    const [p] = await ws.probe(["w-migrated"]);
    expect(p.repos).toEqual([
      { repoId: "backend", status: "ok", branch: "main", detached: false },
      { repoId: "admin", status: "missing", branch: null, detached: false },
    ]);
    expect(await ws.probe(["nope"])).toEqual([]);
  });

  it("addRepos works on the open workspace only, refuses duplicates and trust-less risks", async () => {
    const w = await ws.addRepos([{ token: "mock:/p/third" }]);
    expect(w.repos).toHaveLength(3);
    expect(await code(ws.addRepos([{ token: "mock:/p/third" }]))).toBe("alreadyInWorkspace");
    expect(await code(ws.addRepos([{ token: "mock-risky:/p/r2" }]))).toBe("trustRequired");
    await ws.switch(null, { force: true });
    await ws.ready(2);
    expect(await code(ws.addRepos([{ token: "mock:/p/fourth" }]))).toBe("noWorkspace");
  });

  it("relocate replaces the path, keeps the id, asks for confirmation when the remotes differ", async () => {
    const old = issueMockToken({ path: "/p/old", remotes: ["github.com/a/old"] });
    await ws.addRepos([{ token: old }]);
    const id = ws.activeWorkspace()!.repos.find((r) => r.path === "/p/old")!.id;
    const diff = issueMockToken({ path: "/p/moved", remotes: ["github.com/b/other"] });
    expect(await code(ws.relocateRepo({ repoId: id, token: diff }))).toBe("confirmDifferent");
    const same = issueMockToken({ path: "/p/moved2", remotes: ["github.com/a/old"] });
    await ws.relocateRepo({ repoId: id, token: same });
    expect(ws.activeWorkspace()!.repos.find((r) => r.id === id)!.path).toBe("/p/moved2");
  });

  it("pinned mode: one synthetic entry and every mutation answers pinned", async () => {
    const p = createMockWorkspaces({ seed: SEED, pinned: true });
    const v = await p.list();
    expect(v).toMatchObject({ pinned: true, activeId: "pinned" });
    expect(v.workspaces).toHaveLength(1);
    expect(await code(p.create({ name: "X", repos: [] }))).toBe("pinned");
    expect(await code(p.switch(null, { force: true }))).toBe("pinned");
  });

  it("problem cards: restore needs a listed backup, start fresh empties the list", async () => {
    const bad = createMockWorkspaces({ scenario: "welcome-problem", seed: SEED });
    const v = await bad.list();
    expect(v.problem?.kind).toBe("corrupt");
    expect(await code(bad.restoreBackup("workspaces.0-r0.json"))).toBe("notFound");
    const restored = await bad.restoreBackup(v.problem!.backups[0].name);
    expect(restored.problem).toBeNull();
    expect(restored.workspaces.length).toBeGreaterThan(0);
    const fresh = await createMockWorkspaces({ scenario: "welcome-problem", seed: SEED }).startFresh();
    expect(fresh.workspaces).toEqual([]);
  });

  it("reveal only knows real repos", async () => {
    await ws.reveal("w-migrated", "backend");
    expect(ws.revealed()).toEqual([{ workspaceId: "w-migrated", repoId: "backend" }]);
    expect(await code(ws.reveal("w-migrated", "ghost"))).toBe("workspaceNotFound");
  });

  it("list changes notify subscribers", async () => {
    const cb = vi.fn();
    const off = ws.onListChanged(cb);
    await ws.rename("w3f9a1c2b4", "Renamed");
    expect(cb).toHaveBeenCalledOnce();
    off();
    await ws.rename("w3f9a1c2b4", "Renamed again");
    expect(cb).toHaveBeenCalledOnce();
  });

  it("persists across a page reload and survives a throwing storage", async () => {
    const storage = new MemoryStorage();
    const a = createMockWorkspaces({ seed: SEED, storage });
    await a.rename("w3f9a1c2b4", "Persisted");
    await a.switch("w3f9a1c2b4", { force: true });
    const b = createMockWorkspaces({ seed: SEED, storage });
    expect(b.activeEntry()?.name).toBe("Persisted");
    expect(b.epoch()).toBe(2);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    const c = createMockWorkspaces({ seed: SEED, storage: broken });
    await c.rename("w3f9a1c2b4", "Still works");
    expect((await c.list()).workspaces[1].name).toBe("Still works");
    expect(storage.getItem(MOCK_REGISTRY_KEY)).toBeTruthy();
  });

  it("a welcome scenario starts empty once per tab session and keeps changes across reloads", async () => {
    const storage = new MemoryStorage();
    const session = new MemoryStorage();
    storage.setItem(MOCK_REGISTRY_KEY, JSON.stringify({ stale: true }));
    const first = createMockWorkspaces({ scenario: "welcome", seed: SEED, storage, session });
    expect((await first.list()).workspaces).toEqual([]);
    await first.create({ name: "Mine", repos: [] });
    const reloaded = createMockWorkspaces({ scenario: "welcome", seed: SEED, storage, session });
    expect((await reloaded.list()).workspaces.map((w) => w.name)).toEqual(["Mine"]);
  });
});

describe("createMockIpc with the registry", () => {
  it("normal serves the four-repo workspace as before", async () => {
    const m = createMockIpc("normal", { delayScale: 0 });
    expect((await m.workspaceGet()).repos.map((r) => r.id)).toEqual(["backend", "admin", "services", "pos"]);
    expect((await m.workspaces.list()).activeId).toBe("w-migrated");
  });

  it("welcome serves no repos and refuses workspace_save semantics gracefully", async () => {
    const m = createMockIpc("welcome", { delayScale: 0 });
    expect((await m.workspaceGet()).repos).toEqual([]);
    expect((await m.engineStatus()).repoIds).toEqual([]);
  });

  it("a workspace created in the mock opens with stub repos after a switch (reload)", async () => {
    const storage = new MemoryStorage();
    const reg = createMockWorkspaces({ seed: SEED, storage });
    await reg.switch("w3f9a1c2b4", { force: true });
    const m = createMockIpc("normal", { delayScale: 0, workspaces: createMockWorkspaces({ seed: SEED, storage }) });
    expect((await m.workspaceGet()).repos.map((r) => r.name)).toEqual(["shop-api", "shop-web"]);
    expect((await m.engineStatus()).repoIds).toHaveLength(2);
  });
});
