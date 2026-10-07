import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc", () => ({ ipc: {} }));
const picker = vi.hoisted(() => ({ openPathPicker: vi.fn(), wasTrusted: vi.fn((_p: unknown) => false) }));
vi.mock("../../platform/pathpicker", () => picker);
const dialogs = vi.hoisted(() => ({ reviewPicked: vi.fn(), typedConfirm: vi.fn() }));
vi.mock("./FlowDialogs", () => dialogs);

import { ipc } from "../../ipc";
import { createMockIpc } from "../../ipc/mock";
import { issueMockToken } from "../../ipc/mock/workspaces";
import type { Picked } from "../../ipc/picker";
import { toast } from "../../ui-kit";
import { enterEmptyState } from "../../store/workspace";
import { activeId, resetWorkspacesForTest, setReloadHook, startWorkspaces } from "../../store/workspaces";
import { addRepoFlow, collectTrust, handleDropped, locateFlow, openFolderFlow, uniqueWorkspaceName, usableRepos, workspaceNameFrom } from "./flows";

const picked = (path: string, over: Partial<Picked> = {}, mock: { risks?: string[]; remotes?: string[] } = {}): Picked => ({
  token: issueMockToken({ path, configRisks: mock.risks, remotes: mock.remotes }, "workspaceRepo"),
  path,
  name: path.split("/").pop()!,
  kind: "repo",
  identity: "1:1",
  root: null,
  main: null,
  warnings: [],
  configRisks: mock.risks ?? [],
  remotes: [],
  branch: "main",
  detached: false,
  protectedFolder: null,
  viaSymlink: false,
  gitfileTarget: null,
  ...over,
});

let reload: ReturnType<typeof vi.fn<() => void>>;
let prev: () => void;
let stop: (() => void) | undefined;

async function boot(scenario: string) {
  Object.assign(ipc, createMockIpc(scenario, { delayScale: 0 }));
  stop = startWorkspaces(ipc as never);
  await vi.waitFor(() => expect(activeId() !== undefined).toBe(true));
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  resetWorkspacesForTest();
  enterEmptyState();
  picker.openPathPicker.mockReset();
  picker.wasTrusted.mockReset().mockReturnValue(false);
  dialogs.reviewPicked.mockReset();
  dialogs.typedConfirm.mockReset();
  toast.clear();
  reload = vi.fn<() => void>();
  prev = setReloadHook(reload);
});
afterEach(() => {
  stop?.();
  stop = undefined;
  setReloadHook(prev);
  vi.restoreAllMocks();
});

describe("names", () => {
  it("a workspace name from a folder: NFC, no control or format characters, at most 60 characters", () => {
    expect(workspaceNameFrom("  shop‮-api\u0007 ")).toBe("shop-api");
    expect(workspaceNameFrom("Café")).toBe("Café");
    expect([...workspaceNameFrom("x".repeat(90))]).toHaveLength(60);
    expect(workspaceNameFrom("​")).toBe("Workspace");
  });

  it("a taken name gets (2), still within 60 characters", async () => {
    await boot("welcome-recents");
    expect(uniqueWorkspaceName("Client X")).toBe("Client X (2)");
    expect(uniqueWorkspaceName("brand-new")).toBe("brand-new");
  });
});

describe("usableRepos", () => {
  it("a subfolder or .git folder becomes its repository root; bare, non-git and files are reported", () => {
    const root = picked("/p/repo");
    const sub = picked("/p/repo/src", { kind: "subfolder", root });
    const gitDir = picked("/p/repo/.git", { kind: "gitDir", root });
    const bare = picked("/p/b.git", { kind: "bare" });
    const plain = picked("/p/x", { kind: "notGit" });
    const file = picked("/p/f.txt", { kind: "file" });
    const r = usableRepos([sub, gitDir, bare, plain, file, picked("/p/wt", { kind: "worktree" })]);
    expect(r.repos.map((x) => x.path)).toEqual(["/p/repo", "/p/repo", "/p/wt"]);
    expect(r.problems).toEqual(["Bare repository: it has no working tree, so it cannot be opened.", "Not a Git repository.", "Drop a folder, not a file."]);
  });
});

describe("collectTrust", () => {
  it("asks only for the repositories that need a tick and the picker did not already collect", async () => {
    const a = picked("/p/a", {}, { risks: ["core.fsmonitor"] });
    const b = { ...picked("/p/b", {}, { risks: ["core.hooksPath"] }), trusted: true };
    const c = picked("/p/c");
    dialogs.reviewPicked.mockResolvedValue(new Set([a.token]));
    const got = await collectTrust([a, b, c], "Go");
    expect(dialogs.reviewPicked).toHaveBeenCalledWith([a], "Go");
    expect([...got!].sort()).toEqual([a.token, b.token].sort());
  });

  it("cancel returns null and nothing needs asking returns the already trusted set", async () => {
    dialogs.reviewPicked.mockResolvedValue(null);
    expect(await collectTrust([picked("/p/a", {}, { risks: ["x"] })], "Go")).toBeNull();
    expect((await collectTrust([picked("/p/z")], "Go"))!.size).toBe(0);
    expect(dialogs.reviewPicked).toHaveBeenCalledOnce();
  });
});

describe("openFolderFlow", () => {
  it("cancel changes nothing", async () => {
    await boot("welcome");
    picker.openPathPicker.mockResolvedValue(null);
    await openFolderFlow(ipc as never);
    expect((await ipc.workspaces.list()).workspaces).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it("a repository becomes a one-repository workspace named after the folder, and is opened", async () => {
    await boot("welcome");
    picker.openPathPicker.mockResolvedValue([picked("/Users/example/Projects/shop-api")]);
    await openFolderFlow(ipc as never);
    const view = await ipc.workspaces.list();
    expect(view.workspaces.map((w) => [w.name, w.origin, w.repos.length])).toEqual([["shop-api", "openedFolder", 1]]);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(view.activeId).toBe(view.workspaces[0].id);
  });

  it("the same folder again reuses the workspace (toast, no duplicate)", async () => {
    await boot("welcome");
    picker.openPathPicker.mockResolvedValueOnce([picked("/p/shop")]).mockResolvedValueOnce([picked("/p/shop")]);
    await openFolderFlow(ipc as never);
    stopReload();
    await openFolderFlow(ipc as never);
    expect((await ipc.workspaces.list()).workspaces).toHaveLength(1);
  });

  it("a risky repository needs the trust tick: declining creates nothing; ticking sends trust", async () => {
    await boot("welcome");
    const risky = picked("/p/risky", {}, { risks: ["core.fsmonitor"] });
    picker.openPathPicker.mockResolvedValue([risky]);
    dialogs.reviewPicked.mockResolvedValueOnce(null);
    await openFolderFlow(ipc as never);
    expect((await ipc.workspaces.list()).workspaces).toEqual([]);
    const again = picked("/p/risky", {}, { risks: ["core.fsmonitor"] });
    picker.openPathPicker.mockResolvedValue([again]);
    dialogs.reviewPicked.mockResolvedValueOnce(new Set([again.token]));
    await openFolderFlow(ipc as never);
    expect((await ipc.workspaces.list()).workspaces).toHaveLength(1);
  });

  it("a trust tick collected by the picker is not asked for again", async () => {
    await boot("welcome");
    const risky = picked("/p/risky", {}, { risks: ["core.fsmonitor"] });
    picker.wasTrusted.mockImplementation((p) => (p as Picked).token === risky.token);
    picker.openPathPicker.mockResolvedValue([{ ...risky, trusted: true }]);
    await openFolderFlow(ipc as never);
    expect(dialogs.reviewPicked).not.toHaveBeenCalled();
    expect((await ipc.workspaces.list()).workspaces).toHaveLength(1);
  });

  it("a non-repository result says so", async () => {
    await boot("welcome");
    picker.openPathPicker.mockResolvedValue([picked("/p/plain", { kind: "notGit" })]);
    await openFolderFlow(ipc as never);
    expect(toast.toasts().some((x) => x.title === "Not a Git repository." && x.tone === "danger")).toBe(true);
  });

  it("an error from the picker or the registry becomes one error toast", async () => {
    await boot("welcome");
    picker.openPathPicker.mockRejectedValue({ code: "permissionDenied", message: "x" });
    await openFolderFlow(ipc as never);
    expect(toast.toasts().some((x) => x.title === "macOS blocked access to this folder.")).toBe(true);
  });
});

describe("addRepoFlow", () => {
  it("adds the picked repositories to the open workspace and reports the count", async () => {
    await boot("normal");
    picker.openPathPicker.mockResolvedValue([picked("/p/extra-one"), picked("/p/extra-two")]);
    expect(await addRepoFlow(ipc as never)).toBe(2);
    const open = (await ipc.workspaces.list()).workspaces.find((w) => w.id === "w-migrated")!;
    expect(open.repos.map((r) => r.name)).toEqual(expect.arrayContaining(["extra-one", "extra-two"]));
    expect(toast.toasts().some((x) => x.title === "2 repositories added")).toBe(true);
  });

  it("an identity already in the workspace is an error toast, nothing changes", async () => {
    await boot("normal");
    const existing = (await ipc.workspaceGet()).repos[0];
    picker.openPathPicker.mockResolvedValue([picked(existing.path)]);
    expect(await addRepoFlow(ipc as never)).toBe(0);
    expect(toast.toasts().some((x) => x.title === "Already in this workspace.")).toBe(true);
  });
});

describe("locateFlow", () => {
  it("replaces the folder of a repository", async () => {
    await boot("welcome-vanished");
    picker.openPathPicker.mockResolvedValue([picked("/Users/example/Projects/shop-web-moved")]);
    expect(await locateFlow("w3f9a1c2b4", "web-5e4d3c2b1a", ipc as never)).toBe(true);
    const ws = (await ipc.workspaces.list()).workspaces.find((w) => w.id === "w3f9a1c2b4")!;
    expect(ws.repos.find((r) => r.id === "web-5e4d3c2b1a")?.path).toBe("/Users/example/Projects/shop-web-moved");
  });

  it("a different-looking repository needs the typed name; declining changes nothing", async () => {
    await boot("welcome-vanished");
    const first = picked("/p/old", {}, { remotes: ["github.com/a/old"] });
    picker.openPathPicker.mockResolvedValue([first]);
    expect(await locateFlow("w3f9a1c2b4", "web-5e4d3c2b1a", ipc as never)).toBe(true);
    const second = picked("/p/other", {}, { remotes: ["github.com/b/other"] });
    picker.openPathPicker.mockResolvedValue([second]);
    dialogs.typedConfirm.mockResolvedValueOnce(false);
    expect(await locateFlow("w3f9a1c2b4", "web-5e4d3c2b1a", ipc as never)).toBe(false);
    expect(dialogs.typedConfirm).toHaveBeenCalledWith(expect.objectContaining({ expected: "other" }));
    const third = picked("/p/other", {}, { remotes: ["github.com/b/other"] });
    picker.openPathPicker.mockResolvedValue([third]);
    dialogs.typedConfirm.mockResolvedValueOnce(true);
    expect(await locateFlow("w3f9a1c2b4", "web-5e4d3c2b1a", ipc as never)).toBe(true);
  });
});

describe("handleDropped", () => {
  it("several folders open the New workspace dialog with them", async () => {
    const openNew = vi.fn();
    const items = [picked("/p/a"), picked("/p/b")];
    await handleDropped(items, openNew, ipc as never);
    expect(openNew).toHaveBeenCalledWith(items);
    expect(dialogs.reviewPicked).not.toHaveBeenCalled();
  });

  it("one folder goes through the review card, never straight into a workspace", async () => {
    await boot("welcome");
    const only = picked("/p/solo");
    dialogs.reviewPicked.mockResolvedValueOnce(null);
    await handleDropped([only], vi.fn(), ipc as never);
    expect(dialogs.reviewPicked).toHaveBeenCalledOnce();
    expect((await ipc.workspaces.list()).workspaces).toEqual([]);
    const again = picked("/p/solo");
    dialogs.reviewPicked.mockResolvedValueOnce(new Set<string>());
    await handleDropped([again], vi.fn(), ipc as never);
    expect((await ipc.workspaces.list()).workspaces).toHaveLength(1);
  });

  it("a dropped file is refused with its own message", async () => {
    await handleDropped([picked("/p/f.txt", { kind: "file" })], vi.fn(), ipc as never);
    expect(toast.toasts().some((x) => x.title === "Drop a folder, not a file.")).toBe(true);
  });
});

function stopReload() {
  reload.mockClear();
}
