import { describe, expect, it } from "vitest";
import type { RepoConfig, Workspace } from "../../ipc";
import { addRepo, moveRepo, removeRepo, repoAlreadyIn, repoBadge, repoId, repoProblem, setRepoColor } from "./repos";

const repo = (id: string, order: number, color = "#4caf7d"): RepoConfig => ({ id, path: `/work/${id}`, name: id, color, badge: id.slice(0, 2).toUpperCase(), order, pushTargets: {} });
const ws = (): Workspace => ({ version: 1, repos: [repo("a", 0), repo("b", 1), repo("c", 2)], protectedBranches: ["main"], liveBranches: { a: ["x"], b: ["y"] }, settings: { messageMode: "shared", untrackedChecked: false } });

describe("workspace repo editing", () => {
  it("derives a unique path-safe id and a badge", () => {
    expect(repoId("Shop POS", [])).toBe("shop-pos");
    expect(repoId("Árvíztűrő", ["arvizturo"])).toBe("arvizturo-2");
    expect(repoId("???", [])).toBe("repo");
    expect(repoBadge("Shop POS")).toBe("SP");
    expect(repoBadge("admin")).toBe("AD");
  });

  it("validates a new repo", () => {
    expect(repoProblem(ws(), " ", "/x")).toBe("name");
    expect(repoProblem(ws(), "n", "relative/path")).toBe("path");
    expect(repoProblem(ws(), "n", "/work/a/")).toBe("duplicatePath");
    expect(repoProblem(ws(), "n", "/work/new")).toBeNull();
  });

  it("adds a repo last, with the next free colour", () => {
    const next = addRepo(ws(), " New one ", "/work/new/");
    expect(next.repos.at(-1)).toMatchObject({ id: "new-one", name: "New one", path: "/work/new", badge: "NO", order: 3, pushTargets: {} });
    expect(next.repos.at(-1)!.color).not.toBe("#4caf7d");
  });

  it("removes a repo with its live-branch patterns and moves it with renumbering", () => {
    const removed = removeRepo(ws(), "a");
    expect(removed.repos.map((r) => r.id)).toEqual(["b", "c"]);
    expect(removed.liveBranches).toEqual({ b: ["y"] });
    const moved = moveRepo(ws(), "c", -1);
    expect(moved.repos.map((r) => [r.id, r.order])).toEqual([["a", 0], ["c", 1], ["b", 2]]);
    expect(moveRepo(ws(), "a", -1)).toEqual(ws());
    expect(moveRepo(ws(), "c", 1)).toEqual(ws());
  });

  it("recolours one repo", () => {
    expect(setRepoColor(ws(), "b", "#ff0000").repos.map((r) => r.color)).toEqual(["#4caf7d", "#ff0000", "#4caf7d"]);
  });

  it("knows a folder that is already in the workspace, ignoring a trailing slash", () => {
    expect(repoAlreadyIn(ws(), "/work/a")).toBe(true);
    expect(repoAlreadyIn(ws(), "/work/a/")).toBe(true);
    expect(repoAlreadyIn(ws(), "/work/ab")).toBe(false);
  });
});
