import { describe, expect, it, vi } from "vitest";
import { createMockPicker, MOCK_HOME } from "./mock/picker";

const P = `${MOCK_HOME}/Projects`;
const mk = (o = {}) => createMockPicker({ delayScale: 0, ...o });
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e: { code: string }) => e.code);

describe("mock picker: list", () => {
  it("lists folders first with Git badges, honours the hidden toggle and never probes guarded folders", async () => {
    const pk = mk();
    const l = await pk.list(MOCK_HOME);
    expect(l.parent).toBe("/Users");
    const names = l.entries.map((e) => e.name);
    expect(names).toEqual(["certs", "Desktop", "Documents", "Downloads", "Library", "Projects"]);
    expect(l.entries.find((e) => e.name === "Documents")).toMatchObject({ protectedFolder: "documents", isRepo: null });
    expect(l.entries.find((e) => e.name === "Projects")?.isRepo).toBe(false);
    expect((await pk.list(MOCK_HOME, { hidden: true, files: false })).entries.map((e) => e.name)).toContain(".ssh");
    const files = await pk.list(MOCK_HOME, { hidden: false, files: true });
    expect(files.entries.at(-1)).toMatchObject({ name: "notes.txt", kind: "file" });
  });

  it("marks repos, symlinks, packages and keeps NFD names exact with an NFC label", async () => {
    const l = await mk().list(P);
    expect(l.entries.find((e) => e.name === "api")?.isRepo).toBe(true);
    expect(l.entries.find((e) => e.name === "docs")?.isRepo).toBe(false);
    expect(l.entries.find((e) => e.name === "link-to-api")).toMatchObject({ kind: "symlinkDir", isRepo: true });
    expect(l.entries.find((e) => e.name === "Tool.app")?.package).toBe(true);
    const cafe = l.entries.find((e) => e.label === "café");
    expect(cafe?.name).toBe("café");
  });

  it("filters file kinds by extension", async () => {
    const l = await mk().list(`${MOCK_HOME}/certs`, { hidden: false, files: true, extensions: ["pem", ".crt"] });
    expect(l.entries.map((e) => e.name)).toEqual(["ca.pem", "client.crt"]);
  });

  it("truncates at 2000 entries", async () => {
    const l = await mk().list(`${P}/big`);
    expect(l.entries).toHaveLength(2000);
    expect(l).toMatchObject({ truncated: true, totalSeen: 2100 });
  });

  it("answers permissionDenied for a guarded folder until it is granted", async () => {
    const pk = mk();
    const e = await pk.list(`${MOCK_HOME}/Documents`).catch((x) => x);
    expect(e).toMatchObject({ code: "permissionDenied", detail: "documents" });
    pk.grant(`${MOCK_HOME}/Documents`);
    expect((await pk.list(`${MOCK_HOME}/Documents`)).entries.map((x) => x.name)).toEqual(["Contracts"]);
  });

  it("has a slow folder, typed errors and a jail", async () => {
    const slow = createMockPicker({ delayScale: 0.01 });
    const t = Date.now();
    await slow.list(`${P}/slow`);
    expect(Date.now() - t).toBeLessThan(500);
    const pk = mk();
    expect(await code(pk.list("/nope"))).toBe("notFound");
    expect(await code(pk.list("rel"))).toBe("pathInvalid");
    expect(await code(pk.list(`${P}/api/package.json`))).toBe("notADirectory");
    expect(await code(pk.list("/Volumes/Gone/x"))).toBe("volumeMissing");
    pk.setMode("e2e");
    expect(await code(pk.list(MOCK_HOME))).toBe("testJail");
    expect((await pk.start()).startPath).toBe(P);
    expect((await pk.list(P)).parent).toBeNull();
  });
});

describe("mock picker: pick", () => {
  it("classifies every shape and issues tokens", async () => {
    const pk = mk();
    const kind = async (p: string) => (await pk.pick(p, "workspaceRoot")).kind;
    expect(await kind(`${P}/api`)).toBe("repo");
    expect(await kind(`${P}/feature-wt`)).toBe("worktree");
    expect(await kind(`${P}/vendor-sub`)).toBe("submodule");
    expect(await kind(`${P}/legacy.git`)).toBe("bare");
    expect(await kind(`${P}/docs`)).toBe("notGit");
    expect(await kind(`${P}/api/.git`)).toBe("gitDir");
    const sub = await pk.pick(`${P}/api/src`, "workspaceRoot");
    expect(sub.kind).toBe("subfolder");
    expect(sub.root).toMatchObject({ kind: "repo", path: `${P}/api` });
    expect(sub.root?.token).not.toBe(sub.token);
    const a = await pk.pick(`${P}/api`, "workspaceRoot");
    expect(a).toMatchObject({ branch: "main", detached: false, remotes: [{ name: "origin", host: "github.com" }] });
    expect(a.token.length).toBeGreaterThan(8);
    const risky = await pk.pick(`${P}/client-x`, "workspaceRoot");
    expect(risky.configRisks).toEqual(["core.fsmonitor", "hook:pre-commit"]);
    expect((await pk.pick(`${P}/feature-wt`, "workspaceRoot")).warnings).toContain("limitedSupport");
    expect((await pk.pick(`${P}/redirected`, "workspaceRoot")).warnings).toContain("gitfileRedirect");
  });

  it("resolves symlinks, understands pasted paths and dedupes by identity", async () => {
    const pk = mk();
    const viaLink = await pk.pick(`${P}/link-to-api`, "workspaceRoot");
    const direct = await pk.pick(`${P}/api`, "workspaceRoot");
    expect(viaLink).toMatchObject({ path: `${P}/api`, viaSymlink: true });
    expect(viaLink.identity).toBe(direct.identity);
    for (const raw of [`"${P}/api"`, `file://${P}/api`, "~/Projects/api", ` ${P}/api `]) {
      expect((await pk.pick(raw, "workspaceRoot")).path).toBe(`${P}/api`);
    }
    expect(await code(pk.pick("~bob/x", "workspaceRoot"))).toBe("pathInvalid");
  });

  it("refuses too-broad roots, wrong types and unknown purposes", async () => {
    const pk = mk();
    const home = await pk.pick(MOCK_HOME, "workspaceRoot");
    expect(home.kind).toBe("notGit");
    expect(await code(pk.pick(`${P}/api/package.json`, "workspaceRoot"))).toBe("notADirectory");
    expect(await code(pk.pick(`${P}/api`, "file:caFile"))).toBe("notAFile");
    expect(await code(pk.pick(`${MOCK_HOME}/certs/ca.pem`, "file:caFile"))).toBe("ok");
    expect(await code(pk.pick(`${P}/api`, "bogus" as never))).toBe("pathInvalid");
    expect(await code(pk.pick(`${MOCK_HOME}/Documents/Contracts`, "workspaceRoot"))).toBe("permissionDenied");
    expect((await pk.pick(`${P}/api`, "scanRoot")).kind).toBe("folder");
  });

  it("refuses a dotfiles repository at home as tooBroad", async () => {
    const pk = mk();
    pk.tree().children!.Users.children!.example.git = { shape: "repo", branch: "main" };
    expect(await code(pk.pick(MOCK_HOME, "workspaceRoot"))).toBe("tooBroad");
    expect(await code(pk.pick(`${P}/docs`, "workspaceRoot"))).toBe("tooBroad");
  });
});

describe("mock picker: native", () => {
  it("answers from the script, cancels when it is empty and validates every path", async () => {
    const pk = mk({ native: true });
    expect((await pk.capabilities()).native).toBe(true);
    pk.script({ paths: [`${P}/api`] }, { cancel: true }, { paths: [`${P}/api`, `${P}/shop-frontend`] }, { fail: true });
    expect((await pk.native({ kind: "folder", purpose: "workspaceRoot" }))?.[0].kind).toBe("repo");
    expect(await pk.native({ kind: "folder", purpose: "workspaceRoot" })).toBeNull();
    expect(await pk.native({ kind: "folders", purpose: "workspaceRepo" })).toHaveLength(2);
    expect(await code(pk.native({ kind: "folder", purpose: "workspaceRoot" }))).toBe("nativeFailed");
    expect(await pk.native({ kind: "folder", purpose: "workspaceRoot" })).toBeNull();
    expect(await code(pk.native({ kind: "file", purpose: "workspaceRoot" }))).toBe("pathInvalid");
  });

  it("is unavailable in the browser mock by default and busy while one is open", async () => {
    const pk = mk();
    expect(await code(pk.native({ kind: "folder", purpose: "workspaceRoot" }))).toBe("nativeFailed");
    const on = createMockPicker({ delayScale: 0.5, native: true });
    on.script({ cancel: true });
    const first = on.native({ kind: "folder", purpose: "workspaceRoot" });
    expect(await code(on.native({ kind: "folder", purpose: "workspaceRoot" }))).toBe("busy");
    expect(await first).toBeNull();
  });
});

describe("mock picker: git init", () => {
  it("needs the typed name, consumes the token and then sees a repository", async () => {
    const pk = mk();
    const p = await pk.pick(`${P}/docs`, "workspaceRoot");
    expect(await pk.gitInit(p.token, "wrong").catch((e) => e)).toMatchObject({ code: "pathInvalid", detail: "confirm" });
    const done = await pk.gitInit(p.token, "docs");
    expect(done.kind).toBe("repo");
    expect(await code(pk.gitInit(p.token, "docs"))).toBe("tokenUsed");
    expect(await code(pk.gitInit("f".repeat(32), "x"))).toBe("pathNotValidated");
  });

  it("refuses broad folders, repositories and read-only mode", async () => {
    const pk = mk();
    const desk = await pk.pick(`${MOCK_HOME}/Desktop`, "workspaceRoot");
    expect(await code(pk.gitInit(desk.token, "Desktop"))).toBe("initTooBroad");
    const repo = await pk.pick(`${P}/api`, "workspaceRoot");
    expect(await code(pk.gitInit(repo.token, "api"))).toBe("pathInvalid");
    pk.setMode("readOnly");
    const d = await pk.pick(`${P}/docs`, "workspaceRoot");
    expect(await code(pk.gitInit(d.token, "docs"))).toBe("readOnly");
  });

  it("expires with the mock clock", async () => {
    let t = 1000;
    const pk = mk({ now: () => t });
    const p = await pk.pick(`${P}/docs`, "workspaceRoot");
    t += 5 * 60_000 + 1;
    expect(await code(pk.gitInit(p.token, "docs"))).toBe("tokenExpired");
  });
});

describe("mock picker: scan", () => {
  it("streams progress, finds repos beyond decoys and reports the end", async () => {
    const pk = mk({ scanStepMs: 0 });
    const events: Array<{ done: boolean; found: number }> = [];
    pk.onScan((e) => events.push(e));
    const { scanId } = await pk.scanStart(P, { includeHidden: false });
    await vi.waitFor(() => expect(events.at(-1)?.done).toBe(true));
    const r = await pk.scanResults(scanId);
    const names = r.repos.map((x) => x.name).sort();
    expect(names).toEqual(["api", "client-x", "feature-wt", "redirected", "server", "shop-frontend", "someone-elses", "vendor-sub", "web"]);
    expect(names).not.toContain("dep");
    expect((await pk.scanResults(scanId, r.next)).repos).toEqual([]);
    expect(await code(pk.scanStart("/"))).toBe("scanTooBroad");
  });

  it("can be cancelled and skips guarded children of home", async () => {
    const pk = mk({ scanStepMs: 2 });
    const events: Array<{ done: boolean; cancelled: boolean; skippedProtected: string[] }> = [];
    pk.onScan((e) => events.push(e));
    const { scanId } = await pk.scanStart(MOCK_HOME);
    await pk.scanCancel(scanId);
    await vi.waitFor(() => expect(events.at(-1)?.done).toBe(true));
    expect(events.at(-1)?.cancelled).toBe(true);
    const full = mk({ scanStepMs: 0 });
    const ev: Array<{ done: boolean; skippedProtected: string[] }> = [];
    full.onScan((e) => ev.push(e));
    await full.scanStart(MOCK_HOME);
    await vi.waitFor(() => expect(ev.at(-1)?.done).toBe(true));
    expect([...ev.at(-1)!.skippedProtected].sort()).toEqual(["Desktop", "Documents", "Downloads"]);
  });
});

describe("mock picker: drops", () => {
  it("ignores a drop until a screen listens, then validates into a bounded inbox", async () => {
    const pk = mk();
    const seen = vi.fn();
    pk.onDrop(seen);
    await pk.emitDrop([`${P}/api`]);
    expect(seen).not.toHaveBeenCalled();
    await pk.dropListen(true);
    await pk.emitDrop([`${P}/api`, `${P}/docs`, `${P}/Tool.app`, `${MOCK_HOME}/notes.txt`]);
    expect(seen).toHaveBeenCalledWith({ count: 4 });
    const got = await pk.takeDrop();
    expect(got.map((g) => g.kind)).toEqual(["repo", "notGit", "file", "file"]);
    expect(await pk.takeDrop()).toEqual([]);
  });

  it("expires after 30 s and clears when the screen stops listening", async () => {
    let t = 0;
    const pk = mk({ now: () => t });
    await pk.dropListen(true);
    await pk.emitDrop([`${P}/api`]);
    t += 30_001;
    expect(await pk.takeDrop()).toEqual([]);
    await pk.emitDrop([`${P}/api`]);
    await pk.dropListen(false);
    expect(await pk.takeDrop()).toEqual([]);
  });
});

describe("mock picker: misc", () => {
  it("counts privacy-settings opens and lists places and volumes", async () => {
    const pk = mk();
    await pk.openPrivacySettings();
    expect(pk.privacyOpened()).toBe(1);
    const s = await pk.start();
    expect(s.places.map((x) => x.id)).toEqual(["home", "desktop", "documents", "downloads"]);
    expect(s.volumes).toEqual([{ name: "Backup", path: "/Volumes/Backup" }]);
    expect((await pk.list("/Volumes/Backup")).protectedFolder).toBe("volume");
  });
});
