import { describe, expect, it } from "vitest";
import type { PickedItem } from "./pickerBridge";
import { addPicked, badgeFromName, duplicateBadges, freeBadge, moveDraft, nameProblem, needsTrust, normalize, patchDraft, redeemFrom, removeDraft, suggestedName } from "./workspaceDraft";

const pick = (path: string, over: Partial<PickedItem> = {}): PickedItem => ({
  token: `t:${path}`,
  path,
  name: path.split("/").pop()!,
  kind: "repo",
  identity: `id:${path}`,
  root: null,
  main: null,
  warnings: [],
  configRisks: [],
  remotes: [],
  branch: "main",
  detached: false,
  protectedFolder: null,
  viaSymlink: false,
  gitfileTarget: null,
  ...over,
});

describe("names", () => {
  it("empty, too long, taken (ignoring case and normalisation)", () => {
    expect(nameProblem("  ", [])).toBe("empty");
    expect(nameProblem("x".repeat(61), [])).toBe("long");
    expect(nameProblem("x".repeat(60), [])).toBeNull();
    expect(nameProblem("CAFE\u0301", ["caf\u00e9"])).toBe("taken");
    expect(nameProblem("fresh", ["other"])).toBeNull();
  });
  it("a scan suggests the parent folder name", () => {
    expect(suggestedName("/Users/example/Projects/")).toBe("Projects");
    expect(suggestedName("/")).toBe("Workspace");
  });
});

describe("badges", () => {
  it("initials of two words, or the first two letters", () => {
    expect(badgeFromName("shop-api")).toBe("SA");
    expect(badgeFromName("admin")).toBe("AD");
    expect(badgeFromName("a/b")).toBe("AB");
  });
  it("a taken badge gets the first free variant", () => {
    expect(freeBadge("shop-api", [])).toBe("SA");
    expect(freeBadge("shop-api", ["SA"])).toBe("SH");
    expect(freeBadge("shop-api", ["SA", "SH"])).toBe("SO");
    expect(freeBadge("x", ["X"])).toBe("X1");
  });
});

describe("rows", () => {
  it("adds rows with distinct colours and badges; duplicates by identity or path and non-repositories are skipped", () => {
    const r = addPicked([], [pick("/p/a"), pick("/p/b"), pick("/q/a2", { identity: "id:/p/a" }), pick("/p/c", { kind: "notGit" }), pick("/p/a")]);
    expect(r.drafts.map((d) => d.name)).toEqual(["a", "b"]);
    expect(new Set(r.drafts.map((d) => d.color)).size).toBe(2);
    expect(r.duplicates.map((d) => d.path)).toEqual(["/q/a2", "/p/a"]);
  });

  it("a subfolder result is replaced by its repository root", () => {
    const root = pick("/p/repo");
    const r = addPicked([], [pick("/p/repo/src", { kind: "subfolder", root })]);
    expect(r.drafts.map((d) => d.picked.path)).toEqual(["/p/repo"]);
  });

  it("rows already in the target workspace are duplicates", () => {
    const r = addPicked([], [pick("/p/a"), pick("/p/b")], (p) => p.path === "/p/b");
    expect(r.drafts).toHaveLength(1);
    expect(r.duplicates).toHaveLength(1);
  });

  it("the limit stops the list and reports it", () => {
    const r = addPicked([], [pick("/p/a"), pick("/p/b"), pick("/p/c")], () => false, 2);
    expect(r.drafts).toHaveLength(2);
    expect(r.overLimit).toBe(true);
  });

  it("two folders with the same name read parent/name until the user types a name", () => {
    let drafts = addPicked([], [pick("/work/api"), pick("/client/api"), pick("/work/web")]).drafts;
    expect(drafts.map((d) => d.name)).toEqual(["work/api", "client/api", "web"]);
    expect(new Set(drafts.map((d) => d.badge)).size).toBe(3);
    drafts = patchDraft(drafts, drafts[0].key, { name: "Main API", nameEdited: true });
    expect(drafts.map((d) => d.name)).toEqual(["Main API", "client/api", "web"]);
    drafts = removeDraft(drafts, drafts[0].key);
    // the clash is gone, so the plain folder name comes back
    expect(drafts.map((d) => d.name)).toEqual(["api", "web"]);
    expect(normalize(drafts)[0].name).toBe("api");
  });

  it("a typed badge is kept; equal badges are reported", () => {
    let drafts = addPicked([], [pick("/p/alpha"), pick("/p/alpine")]).drafts;
    drafts = patchDraft(drafts, drafts[1].key, { badge: "AL", badgeEdited: true });
    expect(drafts.map((d) => d.badge)).toEqual(["AL", "AL"]);
    expect([...duplicateBadges(drafts)]).toEqual(["AL"]);
  });

  it("moves up and down within bounds", () => {
    const drafts = addPicked([], [pick("/p/a"), pick("/p/b"), pick("/p/c")]).drafts;
    const keys = (l: typeof drafts) => l.map((d) => d.name);
    expect(keys(moveDraft(drafts, drafts[2].key, -1))).toEqual(["a", "c", "b"]);
    expect(keys(moveDraft(drafts, drafts[0].key, -1))).toEqual(["a", "b", "c"]);
    expect(keys(moveDraft(drafts, drafts[2].key, 1))).toEqual(["a", "b", "c"]);
  });

  it("trust: a risky row needs the tick; the request carries trust only when ticked", () => {
    const [d] = addPicked([], [pick("/p/r", { configRisks: ["core.fsmonitor"] })]).drafts;
    expect(needsTrust(d)).toBe(true);
    expect(redeemFrom(d)).toEqual({ token: "t:/p/r", name: "r", badge: "R", color: d.color });
    const ticked = { ...d, trusted: true };
    expect(needsTrust(ticked)).toBe(false);
    expect(redeemFrom(ticked).trust).toBe(true);
  });
});
