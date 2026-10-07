import { describe, expect, it } from "vitest";
import type { OpOutcome } from "../../ipc/graph";
import { describeOp, errorMessage, needsLiveConfirm, opBlocked } from "./ops";

const outcome = (patch: Partial<OpOutcome>): OpOutcome => ({ repoId: "r", kind: "rebase", status: "idle", step: 0, total: 0, conflictFiles: [], ...patch });

describe("op helpers", () => {
  it("tells conflicts and stops from a finished operation", () => {
    expect(describeOp(outcome({ status: "conflict", step: 2, total: 5, conflictFiles: ["a", "b"] }))).toBe("Rebase stopped at step 2 of 5: 2 conflicting files");
    expect(describeOp(outcome({ kind: "cherryPick", status: "conflict", conflictFiles: ["a"] }))).toBe("Cherry-pick stopped: 1 conflicting file");
    expect(describeOp(outcome({ status: "stopped", step: 1, total: 3, message: "hook failed" }))).toBe("Rebase stopped at step 1 of 3: hook failed");
    expect(describeOp(outcome({ status: "done" }))).toBe("Rebase finished");
    expect(opBlocked(outcome({ status: "conflict" }))).toBe(true);
    expect(opBlocked(outcome({ status: "done" }))).toBe(false);
  });

  it("reads engine errors", () => {
    expect(needsLiveConfirm({ code: "liveBranchConfirm", message: "type main" })).toBe(true);
    expect(needsLiveConfirm(new Error("x"))).toBe(false);
    expect(errorMessage({ code: "git", message: "boom" })).toBe("boom");
    expect(errorMessage(null)).toBe("Unknown error");
  });
});
