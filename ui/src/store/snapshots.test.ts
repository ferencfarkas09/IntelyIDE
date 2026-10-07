import { describe, expect, it, vi } from "vitest";
import type { Ipc } from "../ipc";
import { createSnapshotStore } from "./snapshots";
import { change, snapshot } from "./testing";

describe("snapshot store", () => {
  it("keeps the newest revision and ignores stale or repeated ones", () => {
    const store = createSnapshotStore();
    const seen: number[] = [];
    store.onApplied((s) => seen.push(s.revision));
    expect(store.apply(snapshot("a", [], { revision: 3 }))).toBe(true);
    expect(store.apply(snapshot("a", [change("old.ts")], { revision: 2 }))).toBe(false);
    expect(store.apply(snapshot("a", [change("same.ts")], { revision: 3 }))).toBe(false);
    expect(store.snapshots().a.changes).toEqual([]);
    expect(store.apply(snapshot("a", [change("new.ts")], { revision: 4 }))).toBe(true);
    expect(store.snapshots().a.changes).toHaveLength(1);
    expect(seen).toEqual([3, 4]);
  });

  it("tracks revisions per repo", () => {
    const store = createSnapshotStore();
    store.apply(snapshot("a", [], { revision: 9 }));
    expect(store.apply(snapshot("b", [], { revision: 1 }))).toBe(true);
  });

  it("does not let a slow initial load overwrite a newer event", async () => {
    const store = createSnapshotStore();
    let resolve!: (v: ReturnType<typeof snapshot>) => void;
    const client = { snapshotGet: () => new Promise((r) => (resolve = r)) } as unknown as Ipc;
    const loading = store.load("a", client);
    expect(store.isLoading("a")).toBe(true);
    store.apply(snapshot("a", [change("fresh.ts")], { revision: 5 }));
    resolve(snapshot("a", [change("stale.ts")], { revision: 4 }));
    await loading;
    expect(store.isLoading("a")).toBe(false);
    expect(store.snapshots().a.changes[0].path).toBe("fresh.ts");
  });

  it("reports a failed load, and the error a snapshot carries", async () => {
    const store = createSnapshotStore();
    const client = { snapshotGet: vi.fn().mockRejectedValue({ code: "repoMissing", message: "Repository folder is gone" }) } as unknown as Ipc;
    await store.load("a", client);
    expect(store.repoError("a")).toBe("Repository folder is gone");
    store.apply(snapshot("a", [], { revision: 1, error: "index locked" }));
    expect(store.repoError("a")).toBe("index locked");
    store.apply(snapshot("a", [], { revision: 2 }));
    expect(store.repoError("a")).toBeUndefined();
  });

  it("flags a refresh in flight", async () => {
    const store = createSnapshotStore();
    let done!: () => void;
    const client = { snapshotRefresh: () => new Promise<void>((r) => (done = r)) } as unknown as Ipc;
    const refreshing = store.refresh(null, client);
    expect(store.isRefreshing()).toBe(true);
    done();
    await refreshing;
    expect(store.isRefreshing()).toBe(false);
  });
});
