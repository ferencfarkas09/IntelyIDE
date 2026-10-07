import { describe, expect, it } from "vitest";
import { moveStep, planChanged, previewRebase, setAction, setMessage, type RebaseStep } from "./rebase";

const step = (oid: string, action: RebaseStep["action"] = "pick"): RebaseStep => ({ oid, action, subject: `subject ${oid}` });

describe("rebase plan helpers", () => {
  it("moves a step and clamps the target", () => {
    expect(moveStep(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(moveStep(["a", "b", "c"], 2, -4)).toEqual(["c", "a", "b"]);
    expect(moveStep(["a"], 3, 0)).toEqual(["a"]);
  });

  it("previews squash, fixup, drop and reword", () => {
    const steps = [step("a"), step("b", "squash"), step("c", "drop"), setAction([step("d")], 0, "reword")[0], step("e", "fixup")];
    const { commits, problems } = previewRebase(steps);
    expect(problems).toEqual([]);
    expect(commits).toEqual([
      { subject: "subject a", from: ["a", "b"], reworded: false },
      { subject: "subject d", from: ["d", "e"], reworded: true },
    ]);
  });

  it("starts a reword from the old subject and shows the new one in the preview", () => {
    const planned = setMessage(setAction([step("a")], 0, "reword"), 0, "fix: better words\n\nbody");
    expect(planned[0]).toMatchObject({ action: "reword", message: "fix: better words\n\nbody" });
    expect(previewRebase(planned).commits[0]).toMatchObject({ subject: "fix: better words", reworded: true });
    expect(previewRebase(setMessage(planned, 0, "  ")).problems[0]).toMatch(/needs a message/);
    expect(setAction(planned, 0, "pick")[0].message).toBeUndefined();
  });

  it("reports a squash without a commit before it", () => {
    const { problems } = previewRebase(setAction([step("a"), step("b")], 0, "squash"));
    expect(problems[0]).toMatch(/Step 1/);
    expect(previewRebase([step("a", "drop")]).problems).toEqual(["Every commit is dropped."]);
  });

  it("detects a changed plan", () => {
    const plan = [step("a"), step("b")];
    expect(planChanged(plan, plan)).toBe(false);
    expect(planChanged(plan, moveStep(plan, 0, 1))).toBe(true);
    expect(planChanged(plan, setAction(plan, 1, "drop"))).toBe(true);
  });
});
