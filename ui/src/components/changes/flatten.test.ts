import { describe, expect, it } from "vitest";
import { createMockIpc } from "../../ipc/mock";
import { RepoSelection } from "../../store/selection-model";
import { change, dirChange, repoConfig, snapshot } from "../../store/testing";
import type { RepoSnapshot } from "../../ipc";
import { flattenTree, repoView, type FlattenContext, type TreeRow } from "./flatten";

function ctx(snaps: RepoSnapshot[], over: Partial<FlattenContext> = {}): FlattenContext {
  return {
    repos: snaps.map((s, i) => repoConfig(s.repoId, i)),
    snapshot: (id) => snaps.find((s) => s.repoId === id),
    repoError: (id) => snaps.find((s) => s.repoId === id)?.error ?? undefined,
    repoExpanded: () => true,
    unversionedExpanded: () => false,
    dirExpanded: () => false,
    dirData: () => undefined,
    perRepoMessages: false,
    ...over,
  };
}

const types = (rows: TreeRow[]) => rows.map((r) => r.type);

describe("flattenTree", () => {
  const snap = snapshot("a", [change("src/zeta.ts"), change("lib/Alpha.ts"), change("n.md", "untracked"), dirChange("gen/")]);

  it("lists repo, files sorted by name, then the collapsed Unversioned node", () => {
    const rows = flattenTree(ctx([snap]));
    expect(types(rows)).toEqual(["repo", "file", "file", "unversioned"]);
    expect(rows.filter((r) => r.type === "file").map((r) => (r as Extract<TreeRow, { type: "file" }>).change.path)).toEqual(["lib/Alpha.ts", "src/zeta.ts"]);
    const node = rows[3] as Extract<TreeRow, { type: "unversioned" }>;
    expect(node).toMatchObject({ entries: 2, folders: 1, depth: 1, expanded: false });
  });

  it("shows untracked folders and files below an expanded Unversioned node, folders first", () => {
    const rows = flattenTree(ctx([snap], { unversionedExpanded: () => true }));
    expect(types(rows).slice(3)).toEqual(["unversioned", "dir", "untracked"]);
    expect(rows.slice(3).map((r) => r.depth)).toEqual([1, 2, 2]);
  });

  it("lists the files of an opened folder lazily, with a skeleton, an error or a truncation note", () => {
    const open = { unversionedExpanded: () => true, dirExpanded: () => true };
    const loading = flattenTree(ctx([snap], { ...open, dirData: () => ({ status: "loading", files: [], truncated: false }) }));
    expect(types(loading)).toContain("skeleton");
    const failed = flattenTree(ctx([snap], { ...open, dirData: () => ({ status: "error", files: [], truncated: false, error: "boom" }) }));
    expect(failed.find((r) => r.type === "note")).toMatchObject({ tone: "dirError", text: "boom", dir: "gen/" });
    const files = [change("gen/a.json", "untracked"), change("gen/b.json", "untracked")];
    const loaded = flattenTree(ctx([snap], { ...open, dirData: () => ({ status: "loaded", files, truncated: true }) }));
    const rows = loaded.slice(loaded.findIndex((r) => r.type === "dir"));
    expect(types(rows)).toEqual(["dir", "untracked", "untracked", "note", "untracked"]);
    expect(rows[1].depth).toBe(3);
    expect(rows[3]).toMatchObject({ tone: "truncated" });
  });

  it("collapses a repo to its own row", () => {
    expect(types(flattenTree(ctx([snap], { repoExpanded: () => false })))).toEqual(["repo"]);
  });

  it("adds a state banner, and one message row per repo in per-repo mode", () => {
    const merging = snapshot("m", [change("x.ts")], { state: "merging" });
    expect(types(flattenTree(ctx([merging], { perRepoMessages: true })))).toEqual(["repo", "banner", "message", "file"]);
    expect(types(flattenTree(ctx([merging], { perRepoMessages: true, hasMessageField: () => false })))).toEqual(["repo", "banner", "file"]);
  });

  it("shows skeletons while a snapshot is loading, notes for errors and for clean repos", () => {
    const loading = flattenTree(ctx([snap], { snapshot: () => undefined }));
    expect(types(loading)).toEqual(["repo", "skeleton", "skeleton", "skeleton"]);
    const broken = snapshot("b", [], { error: "index locked" });
    expect(flattenTree(ctx([broken]))[1]).toMatchObject({ type: "note", tone: "error", text: "index locked" });
    expect(flattenTree(ctx([snapshot("c", [])]))[1]).toMatchObject({ type: "note", tone: "empty" });
  });

  it("gives every row a unique, stable key", () => {
    const rows = flattenTree(ctx([snap, snapshot("b", [change("src/zeta.ts")])], { unversionedExpanded: () => true }));
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(flattenTree(ctx([snap])).map((r) => r.key)).toEqual(flattenTree(ctx([snap])).map((r) => r.key));
  });

  it("memoises the sorted view per snapshot", () => {
    expect(repoView(snap.changes)).toBe(repoView(snap.changes));
  });
});

/** What the reference workload in `budget` takes on a quiet machine (about). */
const REFERENCE_QUIET_MS = 8;

describe("5,000 changes", () => {
  // The budget is 50 ms on a quiet machine and grows with how slow a fixed reference workload is right now, so a loaded
  // machine (load 50+) does not fail it, while a real slowdown of the code under test still does. A retry covers a spike.
  const budget = () => {
    const t0 = performance.now();
    for (let round = 0; round < 3; round++) Array.from({ length: 20_000 }, (_, i) => (i * 7919) % 10_007).sort((a, b) => a - b);
    const reference = performance.now() - t0;
    return 50 * Math.min(20, Math.max(1, reference / REFERENCE_QUIET_MS));
  };
  it("flattens and toggles a whole repo inside the load-scaled 50 ms budget", { retry: 3 }, async () => {
    const limit = budget();
    const big = await createMockIpc("big", { delayScale: 0 }).snapshotGet("admin");
    expect(big.changes).toHaveLength(5000);
    const open = { unversionedExpanded: () => true };
    const model = new RepoSelection();
    model.reconcile(big.changes);

    const start = performance.now();
    const rows = flattenTree(ctx([big], open)); // cold: includes the sort
    model.setAllTracked(false);
    const tick = model.repoTick();
    const elapsed = performance.now() - start;

    expect(rows.length).toBeGreaterThan(4900);
    expect(tick).toBe("unchecked");
    expect(elapsed).toBeLessThan(limit);

    const warm = performance.now();
    flattenTree(ctx([big], open));
    model.setAllTracked(true);
    model.setChecked(big.changes[0].path, false);
    model.repoTick();
    expect(performance.now() - warm).toBeLessThan(limit);
  });

  it("derives tri-state from the counts after a single toggle", async () => {
    const big = await createMockIpc("big", { delayScale: 0 }).snapshotGet("admin");
    const model = new RepoSelection();
    model.reconcile(big.changes);
    const first = big.changes.find((c) => c.kind !== "untracked" && c.guard === "ok" && !c.dir)!;
    expect(model.repoTick()).toBe("checked");
    model.setChecked(first.path, false);
    expect(model.repoTick()).toBe("mixed");
    expect(model.checkedCount()).toBe(model.trackedCount() - 1);
  });
});
