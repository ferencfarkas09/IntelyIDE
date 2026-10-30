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
}

/** Settings > Auto-test: never by itself, ask once per repository, or always. */
export type AutotestMode = "off" | "ask" | "always";
/** The remembered answer of one repository in `ask` mode. */
export type RepoAnswer = "yes" | "no";

export interface AutotestPrefs {
  mode: AutotestMode;
  repos: Record<string, RepoAnswer>;
}

export type RepoTestStatus = "waiting" | "running" | "passed" | "failed" | "timeout" | "error" | "noTests";

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
  finishedAt?: number;
}
