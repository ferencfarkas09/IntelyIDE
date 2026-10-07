import { describe, expect, it } from "vitest";
import { RepoSelection, deriveTick, isSelectable } from "./selection-model";
import { change, dirChange } from "./testing";

const tracked = [change("a.ts"), change("b.ts"), change("c.ts", "added", { staged: true })];

describe("deriveTick", () => {
  it("is unchecked for nothing, mixed for some, checked for all", () => {
    expect(deriveTick(0, 0)).toBe("unchecked");
    expect(deriveTick(0, 3)).toBe("unchecked");
    expect(deriveTick(2, 3)).toBe("mixed");
    expect(deriveTick(3, 3)).toBe("checked");
  });
});

describe("isSelectable", () => {
  it("excludes guarded files, conflicts and collapsed directories", () => {
    expect(isSelectable(change("x"))).toBe(true);
    expect(isSelectable(change(".env", "untracked", { guard: "secret" }))).toBe(false);
    expect(isSelectable(change("big.bin", "untracked", { guard: "tooLarge" }))).toBe(false);
    expect(isSelectable(change("m.ts", "conflicted"))).toBe(false);
    expect(isSelectable(dirChange("d/"))).toBe(false);
  });
});

describe("RepoSelection", () => {
  it("ticks tracked changes and leaves untracked files unticked by default", () => {
    const s = new RepoSelection();
    s.reconcile([...tracked, change("new.ts", "untracked")]);
    expect(s.repoTick()).toBe("checked");
    expect(s.isChecked("a.ts")).toBe(true);
    expect(s.isChecked("new.ts")).toBe(false);
    expect(s.checkedPaths()).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(s.unversionedTick()).toBe("unchecked");
  });

  it("derives the repo state from the file ticks instead of storing it", () => {
    const s = new RepoSelection();
    s.reconcile(tracked);
    s.setChecked("a.ts", false);
    expect(s.repoTick()).toBe("mixed");
    s.setChecked("b.ts", false);
    s.setChecked("c.ts", false);
    expect(s.repoTick()).toBe("unchecked");
    s.setChecked("b.ts", true);
    expect(s.repoTick()).toBe("mixed");
    s.setAllTracked(true);
    expect(s.repoTick()).toBe("checked");
    expect(s.checkedCount()).toBe(3);
  });

  it("keeps ticked untracked files out of the way of the repo state", () => {
    const s = new RepoSelection();
    s.reconcile([...tracked, change("n1.ts", "untracked"), change("n2.ts", "untracked")]);
    s.setChecked("n1.ts", true);
    expect(s.repoTick()).toBe("checked");
    expect(s.checkedCount()).toBe(4);
    expect(s.unversionedTick()).toBe("mixed");
    s.setChecked("n2.ts", true);
    expect(s.unversionedTick()).toBe("checked");
    s.setChecked("a.ts", false);
    expect(s.repoTick()).toBe("mixed");
  });

  it("refuses to tick guarded files and conflicts and excludes them from the totals", () => {
    const s = new RepoSelection();
    s.reconcile([change("ok.ts"), change(".env", "untracked", { guard: "secret" }), change("m.ts", "conflicted"), change("g.ts", "modified", { guard: "neverAdd" })]);
    expect(s.setChecked(".env", true)).toBe(false);
    expect(s.setChecked("m.ts", true)).toBe(false);
    expect(s.canSelect("g.ts")).toBe(false);
    expect(s.hasPath(".env")).toBe(true);
    expect(s.checkedPaths()).toEqual(["ok.ts"]);
    expect(s.repoTick()).toBe("checked");
  });

  it("forgets ticks of files that left the snapshot", () => {
    const s = new RepoSelection({ off: ["a.ts", "gone.ts"], on: ["n1.ts", "gone-untracked.ts"] });
    s.reconcile([...tracked, change("n1.ts", "untracked")]);
    expect(s.serialize()).toEqual({ off: ["a.ts"], on: ["n1.ts"] });
  });

  it("restores persisted ticks", () => {
    const first = new RepoSelection();
    first.reconcile([...tracked, change("n.ts", "untracked")]);
    first.setChecked("b.ts", false);
    first.setChecked("n.ts", true);
    const second = new RepoSelection(first.serialize());
    second.reconcile([...tracked, change("n.ts", "untracked")]);
    expect(second.checkedPaths()).toEqual(["a.ts", "c.ts", "n.ts"]);
  });

  describe("collapsed untracked directories", () => {
    const dir = "src/gen/";
    const setup = () => {
      const s = new RepoSelection();
      s.reconcile([change("plain.md", "untracked"), dirChange(dir), ...tracked]);
      return s;
    };
    const files = [change(`${dir}a.json`, "untracked"), change(`${dir}b.json`, "untracked"), change(`${dir}secret.env`, "untracked", { guard: "secret" })];

    it("counts an unlisted directory as unknown, so the node cannot read all-ticked", () => {
      const s = setup();
      s.setChecked("plain.md", true);
      expect(s.unversionedTick()).toBe("mixed");
      expect(s.dirTick(dir)).toBe("unchecked");
      expect(s.unlistedDirs()).toEqual([dir]);
    });

    it("ticks files per directory once it is listed", () => {
      const s = setup();
      s.setDirFiles(dir, files, false);
      expect(s.isDirListed(dir)).toBe(true);
      expect(s.canSelect(`${dir}a.json`)).toBe(true);
      expect(s.canSelect(`${dir}secret.env`)).toBe(false);
      s.setChecked(`${dir}a.json`, true);
      expect(s.dirTick(dir)).toBe("mixed");
      s.setDirChecked(dir, true);
      expect(s.dirTick(dir)).toBe("checked");
      expect(s.checkedPaths()).toEqual(["a.ts", "b.ts", "c.ts", `${dir}a.json`, `${dir}b.json`]);
      s.setAllUntracked(true);
      expect(s.unversionedTick()).toBe("checked");
      s.setAllUntracked(false);
      expect(s.checkedPaths()).toEqual(["a.ts", "b.ts", "c.ts"]);
    });

    it("never reads all-ticked while a listing is truncated", () => {
      const s = setup();
      s.setDirFiles(dir, files, true);
      s.setAllUntracked(true);
      expect(s.dirTick(dir)).toBe("mixed");
      expect(s.unversionedTick()).toBe("mixed");
    });

    it("keeps remembered ticks of an unlisted directory and drops them when the listing disagrees", () => {
      const s = new RepoSelection({ on: [`${dir}a.json`, `${dir}vanished.json`] });
      s.reconcile([dirChange(dir)]);
      expect(s.serialize().on).toEqual([`${dir}a.json`, `${dir}vanished.json`]);
      s.setDirFiles(dir, files, false);
      expect(s.serialize().on).toEqual([`${dir}a.json`]);
    });
  });
});
