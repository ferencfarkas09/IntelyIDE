import { describe, expect, it, vi } from "vitest";
import type { Change } from "../ipc";
import { createSelectionStore, SELECTION_STORAGE_KEY } from "./selection";
import { change, dirChange, snapshot } from "./testing";

function memoryStorage(initial?: string) {
  const data = new Map<string, string>(initial ? [[SELECTION_STORAGE_KEY, initial]] : []);
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}

const files = (dir: string, n: number): Change[] => Array.from({ length: n }, (_, i) => change(`${dir}f${i}.json`, "untracked"));
const base = () => [change("a.ts"), change("b.ts"), change("n.md", "untracked"), dirChange("gen/")];

function setup(storage: ReturnType<typeof memoryStorage> | null = memoryStorage(), listed: Change[] = files("gen/", 3)) {
  const listUntracked = vi.fn(async (_repo: string, _dir: string, _limit: number) => ({ files: listed, truncated: false }));
  const store = createSelectionStore({ storage, listUntracked });
  store.reconcile(snapshot("r", base()));
  return { store, listUntracked, storage };
}

describe("selection store", () => {
  it("ticks tracked files by default and reports the derived repo state", () => {
    const { store } = setup();
    expect(store.repoTick("r")).toBe("checked");
    expect(store.checkedFiles("r")).toEqual(["a.ts", "b.ts"]);
    store.toggleFile("r", "a.ts");
    expect(store.repoTick("r")).toBe("mixed");
    expect(store.fileChecked("r", "a.ts")).toBe(false);
    store.toggleRepo("r");
    expect(store.repoTick("r")).toBe("checked");
    store.toggleRepo("r");
    expect(store.repoTick("r")).toBe("unchecked");
    expect(store.checkedFiles("r")).toEqual([]);
  });

  it("answers for repos it has not seen yet without creating state", () => {
    const { store } = setup();
    expect(store.repoTick("unknown")).toBe("unchecked");
    expect(store.checkedFiles("unknown")).toEqual([]);
  });

  it("summarises ticked files over repos for the commit button", () => {
    const { store } = setup();
    store.reconcile(snapshot("s", [change("x.ts")]));
    expect(store.summary(["r", "s", "none"])).toEqual({ repos: 2, files: 3 });
    store.toggleRepo("s");
    expect(store.summary(["r", "s"])).toEqual({ repos: 1, files: 2 });
  });

  it("persists the deviations and restores them in a new session", () => {
    const { store, storage } = setup();
    store.toggleFile("r", "b.ts");
    store.toggleFile("r", "n.md");
    store.flush();
    const saved = JSON.parse(storage!.data.get(SELECTION_STORAGE_KEY)!);
    expect(saved).toEqual({ r: { off: ["b.ts"], on: ["n.md"] } });

    const next = createSelectionStore({ storage, listUntracked: vi.fn() });
    next.reconcile(snapshot("r", base()));
    expect(next.checkedFiles("r")).toEqual(["a.ts", "n.md"]);
  });

  it("debounces writes", () => {
    vi.useFakeTimers();
    try {
      const { store, storage } = setup();
      store.toggleFile("r", "a.ts");
      store.toggleFile("r", "b.ts");
      expect(storage!.data.has(SELECTION_STORAGE_KEY)).toBe(false);
      vi.advanceTimersByTime(400);
      expect(storage!.data.has(SELECTION_STORAGE_KEY)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives corrupt, hostile and unavailable storage", () => {
    for (const raw of ["{not json", "[]", '"x"', '{"r":{"off":[1,2,{}],"on":"nope"}}']) {
      const { store } = setup(memoryStorage(raw));
      expect(store.checkedFiles("r")).toEqual(["a.ts", "b.ts"]);
    }
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("quota"); }, removeItem: () => { throw new Error("blocked"); } };
    const { store } = setup(throwing as never);
    store.toggleFile("r", "a.ts");
    expect(() => store.flush()).not.toThrow();
    expect(store.fileChecked("r", "a.ts")).toBe(false);
    expect(() => setup(null).store.toggleRepo("r")).not.toThrow();
  });

  it("drops ticks of files that disappear and clears a selected file that is gone", () => {
    const { store } = setup();
    store.toggleFile("r", "a.ts");
    store.setSelectedFile("r", "a.ts");
    store.reconcile(snapshot("r", [change("b.ts"), change("c.ts")]));
    expect(store.selectedFile()).toBeNull();
    expect(store.checkedFiles("r")).toEqual(["b.ts", "c.ts"]);
    store.setSelectedFile("r", "c.ts");
    store.reconcile(snapshot("r", [change("c.ts")]));
    expect(store.selectedFile()).toEqual({ repoId: "r", path: "c.ts" });
  });

  it("refuses to tick guarded files", () => {
    const { store } = setup();
    store.reconcile(snapshot("r", [change("a.ts"), change(".env", "untracked", { guard: "secret" })]));
    store.toggleFile("r", ".env");
    expect(store.fileChecked("r", ".env")).toBe(false);
    expect(store.canSelect("r", ".env")).toBe(false);
  });

  describe("unversioned files and folders", () => {
    it("lists a folder lazily and ticks its files", async () => {
      const { store, listUntracked } = setup();
      expect(store.dirData("r", "gen/")).toBeUndefined();
      await store.loadDir("r", "gen/");
      expect(listUntracked).toHaveBeenCalledWith("r", "gen/", 2000);
      expect(store.dirData("r", "gen/")?.status).toBe("loaded");
      await store.toggleDir("r", "gen/");
      expect(store.dirTick("r", "gen/")).toBe("checked");
      expect(store.checkedFiles("r")).toEqual(["a.ts", "b.ts", "gen/f0.json", "gen/f1.json", "gen/f2.json"]);
      await store.toggleDir("r", "gen/");
      expect(store.dirTick("r", "gen/")).toBe("unchecked");
    });

    it("lists an unlisted folder when it is ticked", async () => {
      const { store, listUntracked } = setup();
      await store.toggleDir("r", "gen/");
      expect(listUntracked).toHaveBeenCalledTimes(1);
      expect(store.dirTick("r", "gen/")).toBe("checked");
    });

    it("ticks everything below the Unversioned node, then clears it again", async () => {
      const { store } = setup();
      expect(store.unversionedTick("r")).toBe("unchecked");
      await store.toggleUnversioned("r");
      expect(store.unversionedTick("r")).toBe("checked");
      expect(store.unversionedBusy("r")).toBe(false);
      expect(store.checkedFiles("r")).toContain("n.md");
      expect(store.checkedFiles("r")).toContain("gen/f2.json");
      await store.toggleUnversioned("r");
      expect(store.unversionedTick("r")).toBe("unchecked");
    });

    it("keeps a failed listing as an error that a retry can clear", async () => {
      const listUntracked = vi.fn().mockRejectedValueOnce(new Error("permission denied")).mockResolvedValue({ files: files("gen/", 1), truncated: false });
      const store = createSelectionStore({ storage: memoryStorage(), listUntracked });
      store.reconcile(snapshot("r", base()));
      await store.loadDir("r", "gen/");
      expect(store.dirData("r", "gen/")).toMatchObject({ status: "error", error: "permission denied" });
      await store.loadDir("r", "gen/");
      expect(store.dirData("r", "gen/")?.status).toBe("loaded");
    });

    it("lists open folders again when a new snapshot arrives", async () => {
      const { store, listUntracked } = setup();
      await store.loadDir("r", "gen/");
      store.watchDir("r", "gen/", true);
      listUntracked.mockClear();
      store.reconcile(snapshot("r", base()));
      await vi.waitFor(() => expect(listUntracked).toHaveBeenCalledTimes(1));
      store.watchDir("r", "gen/", false);
      store.reconcile(snapshot("r", base()));
      expect(listUntracked).toHaveBeenCalledTimes(1);
    });
  });
});
