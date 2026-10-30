import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockAutotest, MOCK_FINGERPRINT, type AutotestApi, type MockOptions } from "./api";
import { buildFixPrompt, canRunTests, createAutotestFlow } from "./flow";
import type { RunLike } from "./logic";
import { parsePrefs, prefs, resetAutotestStore, runAsk, runResults } from "./store";
import type { AutotestPrefs } from "./types";

const FAILING = { lines: ["running 2 tests", "test a::one ... ok", "test a::two ... FAILED", "", "---- a::two stdout ----", "thread 'a::two' panicked at src/a.rs:9:5:", `token ${["ghp", "0123456789abcdefghijABCDEFGHIJ"].join("_")} leaked`, "", "test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s"], exitCode: 101 };

const TRUSTED = { r1: MOCK_FINGERPRINT, r2: MOCK_FINGERPRINT };

/** The mock runner with spies, and a count of how many tests of one repository ran at once. `changes` = what the run
 *  summary says per repository (default: every repository of the run changed one file). */
function harness(opts: MockOptions & { changes?: Record<string, number | null> | null | "throws" } = {}) {
  const inner = createMockAutotest({ durationMs: 5, ...opts });
  const live = new Map<string, number>();
  let maxParallel = 0;
  const api: AutotestApi = {
    ...inner,
    pick: vi.fn(inner.pick),
    start: vi.fn(async (repoId: string, fingerprint: string) => {
      const n = (live.get(repoId) ?? 0) + 1;
      live.set(repoId, n);
      maxParallel = Math.max(maxParallel, n);
      return inner.start(repoId, fingerprint);
    }),
    stop: vi.fn(inner.stop),
    onState: (cb) =>
      inner.onState((s) => {
        if (s.status === "exited") live.set(s.repoId, (live.get(s.repoId) ?? 1) - 1);
        cb(s);
      }),
  };
  let runs: RunLike[] = [];
  const changes = vi.fn(async (runId: string): Promise<Record<string, number | null> | null> => {
    if (opts.changes === "throws") throw new Error("no digest");
    if (opts.changes !== undefined) return opts.changes;
    return Object.fromEntries((runs.find((r) => r.agentId === runId)?.repoIds ?? []).map((id) => [id, 1]));
  });
  const flow = createAutotestFlow({ api: () => api, runs: () => runs, changes, pollMs: 60_000, timeoutMs: opts.durationMs === Infinity ? 30 : 10_000 });
  const set = (next: RunLike[]) => {
    runs = next;
    flow.observe(next);
  };
  return { api, flow, set, changes, maxParallel: () => maxParallel };
}

const run = (agentId: string, status: string, repoIds: string[]): RunLike => ({ agentId, status, repoIds });

function usePrefs(p: Partial<AutotestPrefs>) {
  resetAutotestStore({ mode: "ask", repos: {}, trusted: {}, ...p });
}

const ASK_R1 = { repoId: "r1", runner: "npm run test", command: "vitest run", fingerprint: MOCK_FINGERPRINT };

beforeEach(() => resetAutotestStore());
afterEach(() => vi.restoreAllMocks());

describe("after a run finishes", () => {
  it("asks once per repository naming the command, then runs the tests and remembers the trust", async () => {
    const h = harness();
    h.set([run("a", "running", ["r1"])]);
    h.set([run("a", "done", ["r1"])]);
    await h.flow.idle();
    expect(runAsk("a")).toEqual([ASK_R1]);
    expect(h.api.start).not.toHaveBeenCalled();

    await h.flow.answer("a", "yes");
    await h.flow.idle();
    expect(runAsk("a")).toEqual([]);
    expect(prefs().repos).toEqual({ r1: "yes" });
    expect(prefs().trusted).toEqual({ r1: MOCK_FINGERPRINT });
    expect(h.api.start).toHaveBeenCalledWith("r1", MOCK_FINGERPRINT);
    expect(runResults("a")).toEqual([expect.objectContaining({ repoId: "r1", status: "passed", runner: "npm run test", summary: expect.objectContaining({ passed: 10, failed: 0, matched: true }) })]);

    // the next run on r1 is tested without a question
    h.set([run("a", "done", ["r1"]), run("b", "running", ["r1"])]);
    h.set([run("a", "done", ["r1"]), run("b", "done", ["r1"])]);
    await h.flow.idle();
    expect(runAsk("b")).toEqual([]);
    expect(runResults("b")[0].status).toBe("passed");
    expect(h.api.start).toHaveBeenCalledTimes(2);
  });

  it("remembers No and does not ask again", async () => {
    const h = harness();
    h.set([run("a", "needsYou", ["r1"])]);
    h.set([run("a", "error", ["r1"])]);
    await h.flow.idle();
    await h.flow.answer("a", "no");
    expect(prefs().repos).toEqual({ r1: "no" });
    expect(prefs().trusted).toEqual({});
    h.set([run("a", "error", ["r1"]), run("b", "running", ["r1"])]);
    h.set([run("a", "error", ["r1"]), run("b", "done", ["r1"])]);
    await h.flow.idle();
    expect(runAsk("b")).toEqual([]);
    expect(h.api.start).not.toHaveBeenCalled();
  });

  it("runs trusted repositories in Always mode and never in Off mode", async () => {
    usePrefs({ mode: "always", trusted: TRUSTED });
    const h = harness();
    h.set([run("a", "running", ["r1", "r2"])]);
    h.set([run("a", "done", ["r1", "r2"])]);
    await h.flow.idle();
    expect(runResults("a").map((r) => [r.repoId, r.status])).toEqual([["r1", "passed"], ["r2", "passed"]]);

    usePrefs({ mode: "off", repos: { r1: "yes" } });
    const off = harness();
    off.set([run("a", "running", ["r1"])]);
    off.set([run("a", "done", ["r1"])]);
    await off.flow.idle();
    expect(off.api.pick).not.toHaveBeenCalled();
    expect(runResults("a")).toEqual([]);
    expect(runAsk("a")).toEqual([]);
  });

  it("ignores runs that were already finished when first seen, and repos without tests", async () => {
    usePrefs({ mode: "always", trusted: TRUSTED });
    const h = harness({ picks: { r2: null } });
    h.set([run("a", "done", ["r1"])]);
    await h.flow.idle();
    expect(h.api.pick).not.toHaveBeenCalled();
    h.set([run("a", "done", ["r1"]), run("b", "running", ["r2"])]);
    h.set([run("a", "done", ["r1"]), run("b", "done", ["r2"])]);
    await h.flow.idle();
    expect(h.api.start).not.toHaveBeenCalled();
    expect(runResults("b")).toEqual([]);
  });

  it("tests only the repositories the run touched", async () => {
    usePrefs({ mode: "always", trusted: TRUSTED });
    const h = harness();
    h.set([run("a", "running", ["r1"]), run("b", "done", ["r2"])]);
    h.set([run("a", "done", ["r1"]), run("b", "done", ["r2"])]);
    await h.flow.idle();
    expect(vi.mocked(h.api.start).mock.calls.map((c) => c[0])).toEqual(["r1"]);
  });
});

describe("trust and what a run changed", () => {
  it("asks in Always mode too before a repository's command first runs by itself", async () => {
    usePrefs({ mode: "always" });
    const h = harness();
    h.set([run("a", "running", ["r1"])]);
    h.set([run("a", "done", ["r1"])]);
    await h.flow.idle();
    expect(runAsk("a")).toEqual([ASK_R1]);
    expect(h.api.start).not.toHaveBeenCalled();
  });

  it("reads only real fingerprints as trust from settings.json", () => {
    expect(parsePrefs({ mode: "always", repos: { r1: "yes" }, trusted: { r1: MOCK_FINGERPRINT, r2: true, r3: "yes", r4: "../x" } })).toEqual({ mode: "always", repos: { r1: "yes" }, trusted: { r1: MOCK_FINGERPRINT } });
    expect(parsePrefs(undefined).trusted).toEqual({});
  });

  it("a Yes of an earlier version without a trusted command is not trust", async () => {
    usePrefs({ mode: "ask", repos: { r1: "yes" } });
    const h = harness();
    h.set([run("a", "running", ["r1"])]);
    h.set([run("a", "done", ["r1"])]);
    await h.flow.idle();
    expect(h.api.start).not.toHaveBeenCalled();
    expect(runAsk("a")).toEqual([ASK_R1]);
  });

  it("asks again when the command changed since it was trusted", async () => {
    usePrefs({ mode: "always", trusted: { r1: "aaaaaaaaaaaaaaaa" } });
    const h = harness();
    h.set([run("a", "running", ["r1"])]);
    h.set([run("a", "done", ["r1"])]);
    await h.flow.idle();
    expect(h.api.start).not.toHaveBeenCalled();
    expect(runAsk("a")).toEqual([ASK_R1]);
  });

  it("does not start a command that changed between the question and the start", async () => {
    const h = harness();
    h.set([run("a", "done", ["r1"])]);
    await h.flow.runTests("a", ["r1"], { r1: "aaaaaaaaaaaaaaaa" });
    expect(h.api.start).not.toHaveBeenCalled();
    expect(runResults("a")[0]).toMatchObject({ status: "error", error: "The test command changed since you trusted it. It did not run; the next run asks again." });
  });

  it("never for a read-only run, a repository the run did not change, or when the changes are unknown", async () => {
    usePrefs({ mode: "always", trusted: TRUSTED });
    const ro = harness();
    ro.set([{ ...run("a", "running", ["r1"]), readOnly: true }]);
    ro.set([{ ...run("a", "done", ["r1"]), readOnly: true }]);
    await ro.flow.idle();
    expect(ro.api.pick).not.toHaveBeenCalled();
    expect(ro.changes).not.toHaveBeenCalled();

    const some = harness({ changes: { r1: 0, r2: 3 } });
    some.set([run("b", "running", ["r1", "r2"])]);
    some.set([run("b", "done", ["r1", "r2"])]);
    await some.flow.idle();
    expect(vi.mocked(some.api.start).mock.calls.map((c) => c[0])).toEqual(["r2"]);

    for (const changes of [{ r1: null }, null, "throws" as const]) {
      const h = harness({ changes });
      h.set([run("c", "running", ["r1"])]);
      h.set([run("c", "done", ["r1"])]);
      await h.flow.idle();
      expect(h.api.start).not.toHaveBeenCalled();
      expect(runAsk("c")).toEqual([]);
    }
  });

  it("a run on a server is not tested, by itself or by hand", async () => {
    usePrefs({ mode: "always", trusted: TRUSTED });
    const h = harness();
    const remote = (status: string) => ({ ...run("a", status, ["r1"]), location: "srv1" });
    h.set([remote("running")]);
    h.set([remote("done")]);
    await h.flow.idle();
    expect(h.api.pick).not.toHaveBeenCalled();
    expect(runResults("a")).toEqual([expect.objectContaining({ repoId: "r1", status: "notTested", skip: "server" })]);
    await h.flow.runTests("a", ["r1"]);
    expect(h.api.start).not.toHaveBeenCalled();
    expect(canRunTests([remote("done")], "a", ["r1"])).toBe(false);
  });
});

describe("never while files may still change", () => {
  it("waits while the run itself is live", async () => {
    const h = harness();
    h.set([run("a", "running", ["r1"])]);
    await h.flow.runTests("a", ["r1"]);
    expect(runResults("a")).toEqual([expect.objectContaining({ repoId: "r1", status: "waiting" })]);
    expect(h.api.start).not.toHaveBeenCalled();
    expect(canRunTests([run("a", "running", ["r1"])], "a", ["r1"])).toBe(false);
    // it starts once the run is done
    h.set([run("a", "done", ["r1"])]);
    await h.flow.idle();
    expect(runResults("a")[0].status).toBe("passed");
  });

  it("waits while another run on the same repository is live, not for other repositories", async () => {
    usePrefs({ mode: "always", trusted: TRUSTED });
    const h = harness();
    h.set([run("a", "running", ["r1", "r2"]), run("b", "needsYou", ["r2"])]);
    h.set([run("a", "done", ["r1", "r2"]), run("b", "needsYou", ["r2"])]);
    await h.flow.idle();
    expect(runResults("a").map((r) => [r.repoId, r.status]).sort()).toEqual([["r1", "passed"], ["r2", "waiting"]]);
    expect(vi.mocked(h.api.start).mock.calls.map((c) => c[0])).toEqual(["r1"]);
    expect(canRunTests([run("a", "done", ["r1", "r2"]), run("b", "needsYou", ["r2"])], "a", ["r1", "r2"])).toBe(false);
    h.set([run("a", "done", ["r1", "r2"]), run("b", "running", ["r2"])]);
    await h.flow.idle();
    expect(h.api.start).toHaveBeenCalledTimes(1);
    // b finishes: a's held test of r2 runs, and b's own test of r2 runs after it (one at a time)
    h.set([run("a", "done", ["r1", "r2"]), run("b", "done", ["r2"])]);
    await h.flow.idle();
    expect(runResults("a").map((r) => r.status)).toEqual(["passed", "passed"]);
    expect(runResults("b").map((r) => r.status)).toEqual(["passed"]);
    expect(h.maxParallel()).toBe(1);
  });

  it("runs one test process per repository at a time", async () => {
    const h = harness();
    h.set([run("a", "done", ["r1"]), run("b", "done", ["r1"])]);
    await Promise.all([h.flow.runTests("a", ["r1"]), h.flow.runTests("b", ["r1"])]);
    await h.flow.idle();
    expect(h.api.start).toHaveBeenCalledTimes(2);
    expect(h.maxParallel()).toBe(1);
    expect(runResults("b")[0].status).toBe("passed");
  });
});

describe("results", () => {
  it("parses failures and builds a masked fix prompt", async () => {
    const h = harness({ picks: { r1: { script: "cargo:test", runner: "cargo test", kind: "cargo", command: "cargo test", fingerprint: "fedcba9876543210" } }, outputs: { r1: FAILING } });
    h.set([run("a", "done", ["r1"])]);
    await h.flow.runTests("a", ["r1"]);
    const [r] = runResults("a");
    expect(r).toMatchObject({ status: "failed", kind: "cargo", summary: { passed: 1, failed: 1, matched: true } });
    expect(r.summary!.failures[0].name).toBe("a::two");
    const prompt = buildFixPrompt(runResults("a"), (id) => `Repo ${id}`);
    expect(prompt).toContain("Repo r1");
    expect(prompt).toContain("- a::two: token *** leaked");
    expect(prompt).not.toContain("ghp_0123456789");
  });

  it("stops a test that runs too long and reports the timeout", async () => {
    const h = harness({ durationMs: Infinity });
    h.set([run("a", "done", ["r1"])]);
    await h.flow.runTests("a", ["r1"]);
    expect(h.api.stop).toHaveBeenCalledWith("r1:npm:test");
    expect(runResults("a")[0].status).toBe("timeout");
  });

  it("reports a refused start as an error", async () => {
    const h = harness();
    vi.mocked(h.api.start).mockRejectedValueOnce({ code: "readOnly", message: "Starting a process is refused in read-only mode." });
    h.set([run("a", "done", ["r1"])]);
    await h.flow.runTests("a", ["r1"]);
    expect(runResults("a")[0]).toMatchObject({ status: "error", error: "Starting a process is refused in read-only mode." });
  });

  it("shows No tests found for a repository without a unit-test command", async () => {
    const h = harness({ picks: { r1: null } });
    h.set([run("a", "done", ["r1"])]);
    await h.flow.runTests("a", ["r1"]);
    expect(runResults("a")[0].status).toBe("noTests");
    expect(h.api.start).not.toHaveBeenCalled();
  });
});
