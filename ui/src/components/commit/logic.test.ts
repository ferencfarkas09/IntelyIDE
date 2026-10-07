import { describe, expect, it } from "vitest";
import type { Change, RepoSnapshot } from "../../ipc";
import { buildFileSelections, commitLabel, conventionalHint, describeProblem, HISTORY_LIMIT, planCommit, pushHistory, sensitiveFiles, validateMessage } from "./logic";

const change = (path: string, o: Partial<Change> = {}): Change => ({
  path,
  kind: "modified",
  indexStatus: " ",
  worktreeStatus: "M",
  staged: false,
  partiallyStaged: false,
  guard: "ok",
  ...o,
});

const snapshot = (repoId: string, changes: Change[]): RepoSnapshot =>
  ({ repoId, revision: 1, takenAtMs: 0, head: { detached: false, unborn: false }, ahead: 0, behind: 0, state: "normal", hooks: { kind: "none" }, changes, stashCount: 0, worktreeCount: 0 }) as RepoSnapshot;

describe("validateMessage", () => {
  it("rejects empty and whitespace-only messages", () => {
    expect(validateMessage("")).toEqual({ ok: false, reason: "empty" });
    expect(validateMessage(" \n\t ")).toEqual({ ok: false, reason: "empty" });
    expect(validateMessage("fix: x")).toEqual({ ok: true });
  });
});

describe("conventionalHint", () => {
  it("stays quiet for empty and conforming subjects", () => {
    expect(conventionalHint("")).toBeNull();
    expect(conventionalHint("feat(ui): add push dialog\n\nbody")).toBeNull();
    expect(conventionalHint("fix!: drop old api")).toBeNull();
  });
  it("hints, without blocking, for other subjects", () => {
    expect(conventionalHint("Update stuff")).toBe("feat(scope): subject");
    expect(conventionalHint("feat:missing space")).not.toBeNull();
  });
});

describe("pushHistory", () => {
  it("puts the newest first, drops duplicates and blanks, and caps at 30", () => {
    expect(pushHistory(["a", "b"], "b")).toEqual(["b", "a"]);
    expect(pushHistory(["a"], "  ")).toEqual(["a"]);
    const long = Array.from({ length: 40 }, (_, i) => `m${i}`);
    const next = pushHistory(long, "new");
    expect(next).toHaveLength(HISTORY_LIMIT);
    expect(next[0]).toBe("new");
  });
});

describe("buildFileSelections", () => {
  const changes = [
    change("a.ts"),
    change("new/name.ts", { kind: "renamed", origPath: "old/name.ts" }),
    change(".env", { guard: "secret" }),
    change("dump_x/", { guard: "neverAdd", dir: true }),
    change("untracked-dir/", { dir: true }),
  ];
  it("sends whole-file selections with the rename source", () => {
    expect(buildFileSelections(changes, ["a.ts", "new/name.ts"])).toEqual([
      { mode: "whole", path: "a.ts" },
      { mode: "whole", path: "new/name.ts", origPath: "old/name.ts" },
    ]);
  });
  it("never includes guarded files or collapsed directories", () => {
    expect(buildFileSelections(changes, [".env", "dump_x/", "untracked-dir/"])).toEqual([]);
  });
});

describe("planCommit", () => {
  const snapshots = {
    backend: snapshot("backend", [change("b1.js"), change("b2.js")]),
    admin: snapshot("admin", [change("a1.tsx")]),
    pos: snapshot("pos", [change("p1.js")]),
  };
  const checked: Record<string, string[]> = { backend: ["b1.js", "b2.js"], admin: ["a1.tsx"], pos: [] };
  const base = {
    runId: "r1",
    repoIds: ["backend", "admin", "pos"],
    snapshots,
    checkedFiles: (id: string) => checked[id] ?? [],
    amend: false,
  };

  it("builds one request for the repos that have ticked files, with the shared message", () => {
    const plan = planCommit({ ...base, mode: "shared", sharedMessage: "feat: loyalty\n", repoMessages: {} });
    expect(plan.problems).toEqual([]);
    expect(plan.repos).toBe(2);
    expect(plan.files).toBe(3);
    expect(plan.request).toEqual({
      runId: "r1",
      noVerify: false,
      repos: [
        { repoId: "backend", files: [{ mode: "whole", path: "b1.js" }, { mode: "whole", path: "b2.js" }], message: "feat: loyalty", amend: false },
        { repoId: "admin", files: [{ mode: "whole", path: "a1.tsx" }], message: "feat: loyalty", amend: false },
      ],
    });
  });

  it("reports a missing shared message once and sends nothing", () => {
    const plan = planCommit({ ...base, mode: "shared", sharedMessage: "  ", repoMessages: {} });
    expect(plan.request).toBeNull();
    expect(plan.problems).toEqual([{ kind: "emptyMessage" }]);
  });

  it("allows amend for exactly one repo and refuses it across several", () => {
    const one = planCommit({ ...base, mode: "shared", sharedMessage: "m", repoMessages: {}, amend: true, checkedFiles: (id) => (id === "backend" ? checked.backend! : []) });
    expect(one.request?.repos.map((r) => [r.repoId, r.amend])).toEqual([["backend", true]]);
    const many = planCommit({ ...base, mode: "shared", sharedMessage: "m", repoMessages: {}, amend: true });
    expect(many.request).toBeNull();
    expect(many.problems).toEqual([{ kind: "amendMultiple" }]);
    expect(commitLabel(1, 3, true)).toBe("Amend (3 files)");
  });

  it("blocks conflicted files and amend in a repo with a merge in progress", () => {
    const merging = { ...snapshots.backend, state: "merging" as const, changes: [...snapshots.backend.changes, change("c.js", { kind: "conflicted" })] };
    const plan = planCommit({ ...base, mode: "shared", sharedMessage: "m", repoMessages: {}, snapshots: { ...snapshots, backend: merging } });
    expect(plan.problems).toEqual([{ kind: "conflicts", repoId: "backend" }]);
    const amend = planCommit({ ...base, mode: "shared", sharedMessage: "m", repoMessages: {}, amend: true, snapshots: { ...snapshots, backend: merging }, checkedFiles: (id) => (id === "backend" ? ["b1.js"] : []) });
    expect(amend.problems).toEqual([{ kind: "amendInProgress", repoId: "backend" }]);
  });

  it("uses each repo's own message in per-repo mode and names the repos that lack one", () => {
    const ok = planCommit({ ...base, mode: "perRepo", sharedMessage: "ignored", repoMessages: { backend: "fix: a", admin: "feat: b" } });
    expect(ok.request?.repos.map((r) => [r.repoId, r.message, r.amend])).toEqual([
      ["backend", "fix: a", false],
      ["admin", "feat: b", false],
    ]);
    const missing = planCommit({ ...base, mode: "perRepo", sharedMessage: "x", repoMessages: { backend: "fix: a" } });
    expect(missing.request).toBeNull();
    expect(missing.problems).toEqual([{ kind: "emptyMessage", repoId: "admin" }]);
  });

  it("refuses an empty selection", () => {
    const plan = planCommit({ ...base, checkedFiles: () => [], mode: "shared", sharedMessage: "x", repoMessages: {} });
    expect(plan.request).toBeNull();
    expect(plan.problems).toEqual([{ kind: "noFiles" }]);
  });
});

describe("labels", () => {
  it("shows the target in the button", () => {
    expect(commitLabel(0, 0)).toBe("Commit");
    expect(commitLabel(1, 1)).toBe("Commit (1 repo, 1 file)");
    expect(commitLabel(3, 12)).toBe("Commit (3 repos, 12 files)");
    expect(commitLabel(4, 4515)).toBe("Commit (4 repos, 4,515 files)");
  });
  it("describes problems for the user", () => {
    expect(describeProblem({ kind: "noFiles" })).toMatch(/at least one file/);
    expect(describeProblem({ kind: "emptyMessage", repoId: "admin" }, () => "admin")).toBe("Enter a commit message for admin.");
  });
});

describe("sensitiveFiles", () => {
  it("lists only the committed files that are tracked but look like credentials", () => {
    const snapshots = { a: snapshot("a", [change(".npmrc", { guard: "sensitive" }), change("b.ts"), change("c/.npmrc", { guard: "sensitive" })]) };
    const request = { runId: "r", noVerify: false, repos: [{ repoId: "a", message: "m", amend: false, files: [{ mode: "whole" as const, path: ".npmrc" }, { mode: "whole" as const, path: "b.ts" }] }] };
    expect(sensitiveFiles(request, snapshots)).toEqual([{ repoId: "a", path: ".npmrc" }]);
    expect(sensitiveFiles({ ...request, repos: [] }, snapshots)).toEqual([]);
  });
});
