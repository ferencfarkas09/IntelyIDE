import { describe, expect, it, vi } from "vitest";
import type { SearchBatch, SearchHit, SearchIpc } from "../../ipc/search";
import { handleHint, openCandidate, type OpenDeps } from "./open";

const repos = [
  { id: "admin", path: "/r/admin" },
  { id: "pos", path: "/r/pos" },
];

function deps(hits: SearchHit[] = [], over: Partial<OpenDeps> = {}) {
  const calls: unknown[] = [];
  const listeners = new Set<(b: SearchBatch) => void>();
  const search: SearchIpc = {
    start: vi.fn(async () => {
      setTimeout(() => listeners.forEach((l) => l({ searchId: "s", hits, done: true })), 0);
      return { searchId: "s" };
    }),
    cancel: async () => {},
    onResults: (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
  };
  const execute = vi.fn(async (id: string, args?: unknown) => (calls.push([id, args]), true));
  const d: OpenDeps = { repos: () => repos, repoId: "admin", search, execute, ...over };
  return { d, calls, search, execute };
}

const hit = (path: string, line: number, repoId = "admin"): SearchHit => ({ repoId, path, line, col: 1, preview: "function Login() {" });

describe("handleHint", () => {
  it("opens an exact source position through editor.openFile", async () => {
    const t = deps();
    const o = await handleHint({ file: "/r/admin/src/Login.js", line: 34, col: 7, componentName: "Login" }, t.d);
    expect(o).toMatchObject({ kind: "opened", repoId: "admin", path: "src/Login.js", line: 34, col: 7, confidence: "exact" });
    expect(t.calls).toEqual([["editor.openFile", { repoId: "admin", path: "src/Login.js", line: 34, column: 7 }]]);
    expect(t.search.start).not.toHaveBeenCalled();
  });

  it("never opens a file outside the repos and does not search for the claimed name by path", async () => {
    const t = deps([hit("src/Login.js", 5)]);
    const o = await handleHint({ file: "/etc/passwd", line: 1, col: 1, componentName: "Login" }, t.d);
    expect(t.execute).not.toHaveBeenCalledWith("editor.openFile", expect.objectContaining({ path: "/etc/passwd" }));
    // falls back to the name lookup, which only sees registered repos, and says why
    expect(o).toMatchObject({ kind: "opened", confidence: "name", note: expect.stringContaining("outside your repos") });
  });

  it("a traversal claim without a name is simply rejected", async () => {
    const t = deps();
    const o = await handleHint({ file: "/r/admin/../../etc/passwd", line: 1, col: 1, componentName: "" }, t.d);
    expect(o.kind).toBe("none");
    expect(t.execute).not.toHaveBeenCalled();
  });

  it("name only: one hit opens, several hits ask, none says so", async () => {
    const one = deps([hit("src/Login.js", 5)]);
    expect(await handleHint({ file: "", line: 0, col: 0, componentName: "Login" }, one.d)).toMatchObject({ kind: "opened", path: "src/Login.js", line: 5, confidence: "name" });
    expect(one.search.start).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ repoIds: ["admin"] }));

    const many = deps([hit("src/Login.js", 5), hit("src/old/Login.js", 7)]);
    const o = await handleHint({ file: "", line: 0, col: 0, componentName: "Login" }, many.d);
    expect(o.kind).toBe("pick");
    expect(many.execute).not.toHaveBeenCalled();

    const none = deps([]);
    expect(await handleHint({ file: "", line: 0, col: 0, componentName: "Login" }, none.d)).toMatchObject({ kind: "none" });
  });

  it("without a preview repo the name search covers every registered repo", async () => {
    const t = deps([hit("src/Login.js", 5, "pos")], { repoId: undefined });
    await handleHint({ file: "", line: 0, col: 0, componentName: "Login" }, t.d);
    expect(t.search.start).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ repoIds: ["admin", "pos"] }));
  });

  it("reports an unavailable editor instead of pretending", async () => {
    const t = deps([], { execute: async () => false });
    expect(await handleHint({ file: "/r/admin/src/a.js", line: 1, col: 1, componentName: "" }, t.d)).toEqual({ kind: "none", reason: "The editor is not available" });
  });
});

describe("openCandidate", () => {
  it("re-checks the path against the repo before opening", async () => {
    const t = deps();
    expect(await openCandidate({ repoId: "admin", path: "src/Login.js", line: 5, col: 2, preview: "" }, t.d)).toBe(true);
    expect(t.calls).toEqual([["editor.openFile", { repoId: "admin", path: "src/Login.js", line: 5, column: 2 }]]);
    expect(await openCandidate({ repoId: "admin", path: "../../etc/passwd", line: 1, col: 1, preview: "" }, t.d)).toBe(false);
    expect(await openCandidate({ repoId: "nope", path: "src/a.js", line: 1, col: 1, preview: "" }, t.d)).toBe(false);
    expect(t.calls).toHaveLength(1);
  });
});
