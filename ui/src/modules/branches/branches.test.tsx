import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../store/workspace", () => {
  const repos = [
    { id: "backend", name: "shop-backend", color: "#4caf7d", badge: "HB", path: "/x/backend", order: 0, pushTargets: {} },
    { id: "admin", name: "admin", color: "#8b6cf0", badge: "AD", path: "/x/admin", order: 1, pushTargets: {} },
    { id: "services", name: "shop-mobile", color: "#f0a23a", badge: "SV", path: "/x/services", order: 2, pushTargets: {} },
  ];
  const workspace = () => ({ repos, protectedBranches: ["main", "release/*"], liveBranches: {}, version: 1, settings: {} });
  return { repos: () => repos, repoConfig: (id: string) => repos.find((r) => r.id === id), workspace };
});

import { createMockIpc } from "../../ipc/mock";
import { resetCommands, getCommand } from "../../platform/commands";
import { resetKeymap } from "../../platform/keymap";
import { ipc } from "../../ipc";
import { commitView, setCommitView } from "../../shell/layout";
import { toast } from "../../ui-kit";
import BranchDialogs from "./BranchDialogs";
import BranchPanel from "./BranchPanel";
import { register } from "./index";
import StashPanel from "./StashPanel";
import { createBranch } from "./actions";
import { closeDialog, dialog, openDialog } from "./uiState";

const repo = { id: "backend", name: "shop-backend", color: "#4caf7d", badge: "HB", path: "/x/backend", order: 0, pushTargets: {} };

beforeEach(() => {
  // Same fixtures as the app's mock: backend is on sandbox, admin on feature-light-design, services merging only in its own scenario.
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  closeDialog();
  resetCommands();
  resetKeymap();
  setCommitView("commit");
  toast.clear();
  vi.restoreAllMocks();
});

describe("mock branches", () => {
  const client = createMockIpc("normal", { delayScale: 0 });

  it("switches the repo, keeps the snapshot head in step and reports a per-repo result for switch-all", async () => {
    const seen: string[] = [];
    client.onRepoSnapshot((s) => seen.push(`${s.repoId}:${s.head.branch}`));
    await client.branches.switch("backend", "main");
    expect(seen).toContain("backend:main");
    const results = await client.branches.switchAll("sandbox");
    expect(Object.fromEntries(results.map((r) => [r.repoId, r.status]))).toMatchObject({ backend: "switched", admin: "switched" });
    expect((await client.branches.list("backend")).current).toBe("sandbox");
    expect((await client.branches.switchAll("nope-nothing")).every((r) => r.status === "skipped")).toBe(true);
  });

  it("refuses to delete the current branch and asks for force on an unmerged one", async () => {
    await expect(client.branches.delete("backend", "sandbox")).rejects.toMatchObject({ code: "git" });
    await expect(client.branches.delete("backend", "feature/loyalty-points")).rejects.toMatchObject({ code: "notMerged" });
    await client.branches.delete("backend", "feature/loyalty-points", true);
    expect((await client.branches.list("backend")).local).not.toContain("feature/loyalty-points");
  });

  it("fails the switch of a repo in the middle of a merge and keeps the others going", async () => {
    const merging = createMockIpc("merging", { delayScale: 0 });
    const results = await merging.branches.switchAll("main");
    const byRepo = Object.fromEntries(results.map((r) => [r.repoId, r]));
    expect(byRepo.services.status).toBe("failed");
    expect(byRepo.services.error).toMatch(/merge/);
    expect(byRepo.backend.status).toBe("switched");
  });
});

describe("register()", () => {
  it("adds the palette commands, rollback with its shortcut", () => {
    register();
    expect(["branches.checkout", "branches.new", "branches.switchAll", "git.rollback", "stash.show", "stash.push"].every((id) => getCommand(id))).toBe(true);
    expect(getCommand("git.rollback")?.shortcut).toBe("Mod+Alt+Z");
  });
});

describe("<BranchPanel>", () => {
  it("focuses the search box when it opens, so typing filters at once", async () => {
    render(() => <BranchPanel repo={repo} close={() => {}} />);
    expect(document.activeElement).toBe(screen.getByLabelText("Find a branch"));
  });

  it("lists the branches with live badges, filters and checks out on Enter", async () => {
    const close = vi.fn();
    const switchBranch = vi.spyOn(ipc.branches, "switch").mockResolvedValue();
    render(() => <BranchPanel repo={repo} close={close} />);
    await screen.findByText("Local");
    expect(screen.getAllByText("live").length).toBeGreaterThan(0);
    const filter = screen.getByLabelText("Find a branch");
    fireEvent.input(filter, { target: { value: "release" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("release/2026-10")]));
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(switchBranch).toHaveBeenCalledWith("backend", "release/2026-10");
    expect(close).toHaveBeenCalled();
  });

  it("offers delete for local branches only and opens the new-branch dialog from a row", async () => {
    render(() => <BranchPanel repo={repo} close={() => {}} />);
    await screen.findByText("Local");
    expect(screen.getByLabelText("Delete main")).toBeTruthy();
    expect(screen.queryByLabelText("Delete origin/SHOP-260")).toBeNull();
    expect(screen.getByLabelText("Copy origin/SHOP-260")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("New branch from main"));
    expect(dialog()).toMatchObject({ kind: "newBranch", repoId: "backend", from: "main" });
  });
});

describe("<BranchDialogs>", () => {
  it("requires the exact name before a live branch is deleted", async () => {
    const del = vi.spyOn(ipc.branches, "delete").mockResolvedValue();
    render(() => <BranchDialogs />);
    openDialog({ kind: "delete", repoId: "backend", name: "main", live: true, needsForce: false });
    const button = await screen.findByRole("button", { name: "Delete" });
    expect(button.getAttribute("disabled")).not.toBeNull();
    const field = screen.getByLabelText("Type main to delete it");
    fireEvent.input(field, { target: { value: "Main" } });
    expect(button.getAttribute("disabled")).not.toBeNull();
    fireEvent.input(field, { target: { value: "main" } });
    fireEvent.click(button);
    await waitFor(() => expect(del).toHaveBeenCalledWith("backend", "main", false));
  });

  it("asks again with force when git says the branch is not merged", async () => {
    const del = vi.spyOn(ipc.branches, "delete").mockRejectedValueOnce({ code: "notMerged", message: "not merged" }).mockResolvedValue();
    render(() => <BranchDialogs />);
    openDialog({ kind: "delete", repoId: "backend", name: "feature/x", live: false, needsForce: false });
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Force delete" }));
    await waitFor(() => expect(del).toHaveBeenLastCalledWith("backend", "feature/x", true));
  });

  it("shows one result row per repo after switch-all, including the failed one", async () => {
    vi.spyOn(ipc.branches, "switchAll").mockResolvedValue([
      { repoId: "backend", status: "switched" },
      { repoId: "admin", status: "skipped", error: "already on it" },
      { repoId: "services", status: "failed", error: "The repository is in the middle of a merge" },
      { repoId: "pos", status: "failed", code: "dirtyTree", error: "a.js, b.js" },
      { repoId: "other", status: "skipped", error: "no branch named main" },
    ]);
    render(() => <BranchDialogs />);
    openDialog({ kind: "switchAll", name: "main" });
    fireEvent.click(await screen.findByRole("button", { name: "Switch all" }));
    const list = await screen.findByRole("list", { name: "Result per repository" });
    expect(list.querySelectorAll("li")).toHaveLength(5);
    expect(list.textContent).toContain("No such branch");
    expect(list.textContent).toContain("Already on it");
    expect(list.textContent).toContain("Uncommitted changes");
    expect(list.textContent).toContain("middle of a merge");
    expect(screen.getByText("1 switched, 2 skipped, 2 failed")).toBeTruthy();
  });

  it("rollback names the files, announces the backup, and keeps the backup notice on screen afterwards", async () => {
    const rollback = vi.spyOn(ipc.branches, "rollback").mockResolvedValue({ backupPath: "/backups/r1" });
    render(() => <BranchDialogs />);
    openDialog({ kind: "rollback", targets: [{ repoId: "backend", paths: ["src/a.js", "src/b.js"] }] });
    expect((await screen.findByRole("alertdialog")).textContent).toMatch(/backup folder first/);
    expect(screen.getByText("src/a.js")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }));
    await waitFor(() => expect(rollback).toHaveBeenCalledWith("backend", ["src/a.js", "src/b.js"]));
    await waitFor(() => expect(dialog()).toBeNull());
    const notice = toast.toasts().find((t) => t.description?.includes("/backups/r1"));
    expect(notice?.title).toBe("Rolled back 2 files");
    expect(notice).toMatchObject({ duration: 0, tone: "ok" });
  });
});

describe("actions", () => {
  it("a created branch whose checkout is refused is reported as created, not as a failed creation", async () => {
    const create = vi.spyOn(ipc.branches, "create").mockResolvedValue();
    vi.spyOn(ipc.branches, "switch").mockRejectedValue({ code: "dirtyTree", message: "3 files have uncommitted changes" });
    expect(await createBranch("backend", "feature/x", undefined, true)).toBe(true);
    expect(create).toHaveBeenCalledOnce();
    const t = toast.toasts().find((x) => x.description?.includes("uncommitted changes"));
    expect(t?.title).toMatch(/^Created feature\/x, but could not switch to it/);
  });

  it("a failed creation keeps the dialog open", async () => {
    vi.spyOn(ipc.branches, "create").mockRejectedValue({ code: "exists", message: "exists" });
    expect(await createBranch("backend", "feature/x", undefined, true)).toBe(false);
  });
});

describe("<StashPanel>", () => {
  it("lists the stashes of every repo and pops one", async () => {
    const pop = vi.spyOn(ipc.branches, "stashPop").mockResolvedValue();
    vi.spyOn(ipc.branches, "stashList").mockImplementation(async (id) => (id === "backend" ? [{ index: 0, message: "WIP on loyalty", branch: "sandbox", createdMs: Date.now() - 7_200_000 }] : []));
    render(() => <StashPanel />);
    await screen.findByText("WIP on loyalty");
    expect(screen.getByText(/on sandbox · 2h ago · stash@\{0\}/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Stash ticked files/ }).getAttribute("disabled")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pop" }));
    await waitFor(() => expect(pop).toHaveBeenCalledWith("backend", 0));
  });

  it("asks before dropping", async () => {
    vi.spyOn(ipc.branches, "stashList").mockResolvedValue([{ index: 1, message: "Before rebase", createdMs: Date.now() }]);
    const drop = vi.spyOn(ipc.branches, "stashDrop").mockResolvedValue();
    render(() => (
      <>
        <StashPanel />
        <BranchDialogs />
      </>
    ));
    fireEvent.click((await screen.findAllByLabelText(/Drop stash 1 of shop-backend/))[0]);
    expect(drop).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Drop" }));
    await waitFor(() => expect(drop).toHaveBeenCalledWith("backend", 1));
  });

  it("the stash tab is enabled and the view signal switches it", () => {
    expect(commitView()).toBe("commit");
    setCommitView("stash");
    expect(commitView()).toBe("stash");
  });
});
