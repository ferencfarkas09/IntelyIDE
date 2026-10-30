// Wire types of "Auto-test after a run" (`autotest_pick`, `autotest_start`) and the module's own state.
import type { TestSummary } from "./logic";

/** Which runner a pick drives (crates/runner/src/autotest.rs `TestKind`). */
export type TestKind = "vitest" | "jest" | "cargo" | "pytest" | "unknown";

/** The unit-test command the backend chose for one repository. */
export interface TestPick {
  /** `npm:test`, `cargo:test`, `pytest:test`. */
  script: string;
  /** What runs, safe to show (`npm run test`). */
  runner: string;
  kind: TestKind;
  /** The command the runner executes (the script body for npm), masked; shown on the trust question. */
  command: string;
  /** Changes when the repository changes what runs; the trust of a repository is bound to it. */
  fingerprint: string;
}

/** One repository of the trust question: what would run there. */
export interface AskItem {
  repoId: string;
  runner: string;
  command: string;
  fingerprint: string;
}

/** Settings > Auto-test: never by itself, ask once per repository, or always (in trusted repositories). */
export type AutotestMode = "off" | "ask" | "always";
/** The remembered answer of one repository in `ask` mode. */
export type RepoAnswer = "yes" | "no";

export interface AutotestPrefs {
  mode: AutotestMode;
  repos: Record<string, RepoAnswer>;
  /**
   * The repositories the person trusted to run their own test command unattended, with the fingerprint of the command
   * they saw. Only an explicit Yes on the trust question sets it; a changed command needs a new Yes. Every mode needs it.
   */
  trusted: Record<string, string>;
}

/** `notTested`: auto-test left the repository out on purpose (`skip` says why). */
export type RepoTestStatus = "waiting" | "running" | "passed" | "failed" | "timeout" | "error" | "noTests" | "notTested";

/** Why a repository was not tested: the run worked on a server, so the local copy says nothing about its change. */
export type SkipReason = "server";

/** The test result of one repository of one run. */
export interface RepoTest {
  repoId: string;
  status: RepoTestStatus;
  runner?: string;
  kind?: TestKind;
  serverId?: string;
  summary?: TestSummary;
  /** Why it could not run (`readOnly`, `confirmRequired`, ...), already a sentence. */
  error?: string;
  skip?: SkipReason;
  finishedAt?: number;
}
