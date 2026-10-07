import { describe, expect, it } from "vitest";
import type { OpEvent, OpResult } from "../../ipc";
import { applyEvent, applyResult, describeFailure, MAX_OUTPUT_LINES, newRun, statusTone, summarizeRun, summarizeStatuses } from "./logic";

const event = (o: Partial<OpEvent>): OpEvent => ({ runId: "r", repoId: "a", kind: "commit", status: "hooks", ...o });

describe("run state", () => {
  it("collects status, progress and output lines per repo", () => {
    const run = newRun("r", "commit", ["a", "b"]);
    applyEvent(run, event({ line: { stream: "stderr", text: "husky" } }));
    applyEvent(run, event({ status: "pushing", percent: 40, line: { stream: "stdout", text: "x" } }));
    expect(run.repos.a.status).toBe("pushing");
    expect(run.repos.a.percent).toBe(40);
    expect(run.repos.a.lines.map((l) => l.text)).toEqual(["husky", "x"]);
    expect(run.repos.b.status).toBe("queued");
  });

  it("does not let a late progress event reopen a finished repo", () => {
    const run = newRun("r", "push", ["a"]);
    applyEvent(run, event({ status: "failed" }));
    applyEvent(run, event({ status: "pushing", percent: 90 }));
    expect(run.repos.a.status).toBe("failed");
  });

  it("caps the output kept in memory", () => {
    const run = newRun("r", "commit", ["a"]);
    for (let i = 0; i < MAX_OUTPUT_LINES + 50; i++) applyEvent(run, event({ line: { stream: "stderr", text: `l${i}` } }));
    expect(run.repos.a.lines).toHaveLength(MAX_OUTPUT_LINES);
    expect(run.repos.a.lines.at(-1)?.text).toBe(`l${MAX_OUTPUT_LINES + 49}`);
  });

  it("takes statuses from the result, keeps failure output when nothing was streamed, and cancels what never reported", () => {
    const run = newRun("r", "push", ["a", "b", "c"]);
    const result: OpResult = {
      runId: "r",
      kind: "push",
      finishedAtMs: 5,
      repos: [
        { repoId: "a", status: "done", reconciled: true, hookModifiedFiles: [] },
        { repoId: "b", status: "failed", reconciled: true, hookModifiedFiles: [], failure: { kind: "nonFastForward", message: "rejected", output: "! [rejected]\nhint" } },
      ],
    };
    applyResult(run, result);
    expect(run.finishedAtMs).toBe(5);
    expect(run.repos.a.status).toBe("done");
    expect(run.repos.b.lines.map((l) => l.text)).toEqual(["! [rejected]", "hint"]);
    expect(run.repos.c.status).toBe("cancelled");
    expect(summarizeRun(run)).toBe("Push finished: 1 done, 1 failed, 1 cancelled");
  });

  it("summarises the visible rows of a commit and a push run together", () => {
    expect(summarizeStatuses(["commit", "commit", "push"], ["failed", "failed", "failed"])).toBe("Commit and push finished: 0 done, 3 failed");
    expect(summarizeStatuses(["push"], ["done", "failed"])).toBe("Push finished: 1 done, 1 failed");
    expect(summarizeStatuses(["commit", "push"], ["failed", "pushing"])).toBe("Commit and push in progress");
  });

  it("summarises a running run", () => {
    expect(summarizeRun(newRun("r", "commit", ["a"]))).toBe("Commit in progress");
  });
});

describe("failure wording", () => {
  it("offers the recovery that fits the failure", () => {
    expect(describeFailure("hookRejected", "commit").actions).toEqual(["retry", "retryNoHooks"]);
    expect(describeFailure("hookRejected", "push").title).toBe("Pre-push hook failed");
    expect(describeFailure("nonFastForward", "push").actions[0]).toBe("pullThenPush");
    expect(describeFailure("lockBusy", "commit").actions).toEqual(["retry"]);
    expect(describeFailure("emptyMessage", "commit").actions).toEqual([]);
  });
  it("maps statuses to tones", () => {
    expect(statusTone("done")).toBe("ok");
    expect(statusTone("failed")).toBe("danger");
    expect(statusTone("cancelled")).toBe("warn");
    expect(statusTone("hooks")).toBe("accent");
  });
});
