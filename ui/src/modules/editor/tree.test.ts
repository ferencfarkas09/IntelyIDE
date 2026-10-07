import { describe, expect, it } from "vitest";
import type { TreeNode } from "./logic";
import { decorationOf } from "./tree";

const node = (kind: TreeNode["kind"], gitStatus: string): TreeNode => ({ key: "r:src", repoId: "r", path: "src", name: "src", kind, depth: 1, entry: { name: "src", kind: kind === "file" ? "file" : "dir", gitStatus } });

describe("decorationOf", () => {
  it("never strikes a listed folder through because something below it was deleted", () => {
    expect(decorationOf(node("dir", "D")).kind).toBeUndefined();
    expect(decorationOf(node("dir", "M")).kind).toBeUndefined();
  });

  it("keeps the status of a folder that is itself new, and of every file", () => {
    expect(decorationOf(node("dir", "?")).kind).toBe("untracked");
    expect(decorationOf(node("file", "D")).kind).toBe("deleted");
    expect(decorationOf(node("file", "M")).kind).toBe("modified");
  });
});
