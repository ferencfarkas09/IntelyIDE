// The flow of "Auto-test after a run": when a run finishes, test the repositories it touched (by the mode in Settings),
// one test process per repository at a time, never while that run or another run on the same repository may still be
// writing. A test is started on the backend (`autotest_start`), followed through the Run panel's state events until it
// exits or the time cap stops it, then its log is parsed.
import { t } from "../../i18n";
import type { ServerInfo } from "../../ipc/run";
import type { AutotestApi } from "./api";
import { blockedBy, finishedBetween, linesOfLastStart, maskSecrets, outcomeOf, parseTestOutput, type RunLike } from "./logic";
import { dropRepoResult, prefs, rememberAnswer, repoResult, runAsk, runResults, setRepoResult, setRunAsk } from "./store";
import type { RepoAnswer, RepoTest, TestPick } from "./types";

export const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const POLL_MS = 2000;

export interface FlowDeps {
  api: () => AutotestApi;
  runs: () => RunLike[];
  timeoutMs?: number;
  pollMs?: number;
}

export interface AutotestFlow {
  /** Feed the current runs; a run that went from working to done or error is tested (by the mode). */
  observe(runs: RunLike[]): void;
  /** Tests the given repositories of a run now (Re-run, the header button, the palette). */
  runTests(runId: string, repoIds: string[]): Promise<void>;
  /** The answer of the "run tests?" card; remembered for each repository it lists. */
  answer(runId: string, answer: RepoAnswer): Promise<void>;
  /** Waits for what was started so far (tests). */
  idle(): Promise<void>;
  /** Takes the runs as they are now without acting on them, so only a run that finishes after this is tested. */
  prime(runs: RunLike[]): void;
  /** Switched off: forgets the runs seen and drops the tests held back (a run that finishes while off is never tested). */
  reset(): void;
}

const errorText = (e: unknown): string => (e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e));

export function createAutotestFlow(deps: FlowDeps): AutotestFlow {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? POLL_MS;
  /** The tail of each repository's queue: one test process per repository at a time. */
  const locks = new Map<string, Promise<void>>();
  /** Tests held back because a run on the repository is still live: `runId\0repoId`. */
  const pending = new Map<string, { runId: string; repoId: string }>();
  const work = new Set<Promise<unknown>>();
  let seen = new Map<string, string>();

  const track = <T>(p: Promise<T>): Promise<T> => {
    work.add(p);
    void p.finally(() => work.delete(p)).catch(() => {});
    return p;
  };

  function hold(runId: string, repoId: string): void {
    pending.set(`${runId}\0${repoId}`, { runId, repoId });
    const prev = repoResult(runId, repoId);
    setRepoResult(runId, { repoId, status: "waiting", runner: prev?.runner, kind: prev?.kind });
  }

  function enqueue(runId: string, repoId: string): Promise<void> {
    const prev = repoResult(runId, repoId);
    // already testing this repository for this run: nothing to add
    if (prev?.status === "running") return locks.get(repoId) ?? Promise.resolve();
    if (locks.has(repoId)) setRepoResult(runId, { repoId, status: "waiting", runner: prev?.runner, kind: prev?.kind });
    const tail = (locks.get(repoId) ?? Promise.resolve()).then(() => testRepo(runId, repoId));
    const mine = tail.finally(() => {
      if (locks.get(repoId) === mine) locks.delete(repoId);
    });
    locks.set(repoId, mine);
    return track(mine);
  }

  async function testRepo(runId: string, repoId: string): Promise<void> {
    if (blockedBy(deps.runs(), runId, repoId)) return hold(runId, repoId);
    const api = deps.api();
    let pick: TestPick | null;
    try {
      pick = await api.pick(repoId);
    } catch (e) {
      return setRepoResult(runId, { repoId, status: "error", error: errorText(e), finishedAt: Date.now() });
    }
    if (!pick) return setRepoResult(runId, { repoId, status: "noTests", finishedAt: Date.now() });
    const base: RepoTest = { repoId, status: "running", runner: pick.runner, kind: pick.kind };
    setRepoResult(runId, base);

    let serverId: string | undefined;
    const early: ServerInfo[] = [];
    let settle!: (s: ServerInfo | "timeout") => void;
    const ended = new Promise<ServerInfo | "timeout">((r) => (settle = r));
    const isEnd = (s: ServerInfo) => s.status === "exited" || s.status === "failed";
    const off = api.onState((s) => {
      if (serverId === undefined) early.push(s);
      else if (s.id === serverId && isEnd(s)) settle(s);
    });
    let info: ServerInfo;
    try {
      info = await api.start(repoId);
    } catch (e) {
      off();
      return setRepoResult(runId, { ...base, status: "error", error: errorText(e), finishedAt: Date.now() });
    }
    serverId = info.id;
    setRepoResult(runId, { ...base, serverId });
    const already = [info, ...early].find((s) => s.id === serverId && isEnd(s));
    if (already) settle(already);
    const poll = setInterval(() => {
      void api.list().then((all) => {
        const s = all.find((x) => x.id === serverId);
        if (s && isEnd(s)) settle(s);
      }, () => {});
    }, pollMs);
    const cap = setTimeout(() => settle("timeout"), timeoutMs);
    const end = await ended;
    clearInterval(poll);
    clearTimeout(cap);
    off();
    if (end === "timeout") await api.stop(serverId).catch(() => {});
    const log = await api.logs(serverId, 0).catch(() => ({ lines: [] as string[] }));
    const lines = linesOfLastStart(log.lines, info.runner);
    const summary = parseTestOutput(lines, pick.kind);
    const finishedAt = Date.now();
    if (end === "timeout") return setRepoResult(runId, { ...base, serverId, status: "timeout", summary, finishedAt });
    if (end.status === "failed") {
      const why = [...lines].reverse().find((l) => l.trim() && !l.startsWith("───"));
      return setRepoResult(runId, { ...base, serverId, status: "error", error: why, summary, finishedAt });
    }
    setRepoResult(runId, { ...base, serverId, status: outcomeOf(summary, end.exitCode), summary, finishedAt });
  }

  function runTests(runId: string, repoIds: string[]): Promise<void> {
    const runs = deps.runs();
    const jobs = [...new Set(repoIds)].map((repoId) => {
      if (blockedBy(runs, runId, repoId)) {
        hold(runId, repoId);
        return Promise.resolve();
      }
      pending.delete(`${runId}\0${repoId}`);
      return enqueue(runId, repoId);
    });
    return Promise.all(jobs).then(() => {});
  }

  async function onFinished(runId: string): Promise<void> {
    const p = prefs();
    if (p.mode === "off") return;
    const run = deps.runs().find((r) => r.agentId === runId);
    if (!run) return;
    const go: string[] = [];
    const ask: string[] = [];
    for (const repoId of run.repoIds) {
      const answer = p.repos[repoId];
      if (p.mode === "ask" && answer === "no") continue;
      let pick: TestPick | null = null;
      try {
        pick = await deps.api().pick(repoId);
      } catch {
        continue;
      }
      if (!pick) continue;
      if (p.mode === "always" || answer === "yes") go.push(repoId);
      else ask.push(repoId);
    }
    if (ask.length) setRunAsk(runId, [...new Set([...runAsk(runId), ...ask])]);
    if (go.length) await runTests(runId, go);
  }

  function drain(runs: RunLike[]): void {
    for (const [key, { runId, repoId }] of [...pending]) {
      if (blockedBy(runs, runId, repoId)) continue;
      pending.delete(key);
      void enqueue(runId, repoId);
    }
  }

  return {
    observe(runs) {
      const done = finishedBetween(seen, runs);
      seen = new Map(runs.map((r) => [r.agentId, r.status]));
      for (const id of done) void track(onFinished(id));
      drain(runs);
    },
    runTests,
    async answer(runId, answer) {
      const repoIds = runAsk(runId);
      setRunAsk(runId, []);
      if (!repoIds.length) return;
      rememberAnswer(repoIds, answer);
      if (answer === "yes") await runTests(runId, repoIds);
    },
    async idle() {
      while (work.size) await Promise.allSettled([...work]);
    },
    prime(runs) {
      seen = new Map(runs.map((r) => [r.agentId, r.status]));
    },
    reset() {
      seen = new Map();
      for (const { runId, repoId } of pending.values()) if (repoResult(runId, repoId)?.status === "waiting") dropRepoResult(runId, repoId);
      pending.clear();
    },
  };
}

/** Whether a Re-run of this run's tests would start now (not while it or another run on its repositories is live, nor twice). */
export function canRunTests(runs: RunLike[], runId: string, repoIds: string[]): boolean {
  if (!repoIds.length) return false;
  if (repoIds.some((r) => blockedBy(runs, runId, r))) return false;
  return !runResults(runId).some((r) => r.status === "running" || r.status === "waiting");
}

/** The prompt of "Ask the agent to fix the failing tests": the failures of each repository, masked. */
export function buildFixPrompt(tests: RepoTest[], nameOf: (repoId: string) => string): string {
  const parts = [t("autotest.prompt.intro")];
  for (const r of tests) {
    if (r.status !== "failed") continue;
    const s = r.summary;
    parts.push("", t("autotest.prompt.repo", { repo: nameOf(r.repoId), runner: r.runner ?? "" }));
    if (s?.matched) parts.push(t("autotest.prompt.counts", { failed: s.failed, passed: s.passed }));
    for (const f of s?.failures ?? []) parts.push(`- ${f.name}${f.message ? `: ${f.message}` : ""}`);
    if (!s?.failures.length) parts.push(t("autotest.prompt.noDetail"));
  }
  parts.push("", t("autotest.prompt.outro"));
  return maskSecrets(parts.join("\n"));
}
