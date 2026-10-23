import { describe, expect, it } from "vitest";
import { pickFixRepos } from "./repos";

const repos = [
  { id: "backend", name: "shop-backend" },
  { id: "admin", name: "shop-admin" },
  { id: "mobile", name: "shop-mobile" },
  { id: "pos", name: "shop-pos" },
];
const ids = (r: ReturnType<typeof pickFixRepos>) => r && { primary: r.primary.map((x) => x.id), related: r.related.map((x) => x.id), source: r.source };

describe("pickFixRepos", () => {
  it("follows the map of Settings: the first repository is the work, the others may change with it", () => {
    expect(ids(pickFixRepos("shop-admin", { "shop-admin": ["shop-admin", "Shop_Backend"] }, repos))).toEqual({ primary: ["admin"], related: ["backend"], source: "map" });
    // a project written differently still finds its entry; a name that is no repository of this workspace is skipped
    expect(ids(pickFixRepos("Shop Admin", { "shop-admin": ["gone", "shop-pos"] }, repos))).toEqual({ primary: ["pos"], related: [], source: "map" });
  });

  it("takes the only repository there is", () => {
    expect(ids(pickFixRepos("anything", {}, [repos[3]]))).toEqual({ primary: ["pos"], related: [], source: "only" });
  });

  it("matches the project to a repository by name when nothing is mapped", () => {
    expect(ids(pickFixRepos("shop-pos", {}, repos))).toEqual({ primary: ["pos"], related: [], source: "name" });
    expect(ids(pickFixRepos("pos", {}, [...repos, { id: "x", name: "other" }]))).toBeUndefined(); // too short to guess from
    expect(ids(pickFixRepos("shop-mobile-app", {}, repos))).toEqual({ primary: ["mobile"], related: [], source: "name" });
  });

  it("does not guess between several likely ones, or when there is nothing to go on", () => {
    expect(pickFixRepos("shop", {}, repos)).toBeUndefined();
    expect(pickFixRepos(undefined, {}, repos)).toBeUndefined();
    expect(pickFixRepos("unrelated-service", {}, repos)).toBeUndefined();
  });

  it("falls back to the guess when the map has nothing usable for the project", () => {
    expect(ids(pickFixRepos("shop-pos", { "shop-pos": ["gone"] }, repos))?.source).toBe("name");
  });
});
