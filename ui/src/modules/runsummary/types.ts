// Mirrors `intely_runindex::digest` (hand-written: this extra has no bindings file). Every text is already scrubbed by
// the backend (secrets masked), every list is capped.

export type Purpose = "ui" | "styles" | "tests" | "config" | "dependencies" | "docs" | "ios" | "android" | "server" | "code" | "assets" | "other";

export type CheckCode = "devServer" | "reinstall" | "iosBuild" | "androidBuild" | "runTests" | "reviewDeleted" | "reviewFailures" | "answerNeeds";

export type RiskCode = "configTouched" | "lockfileChanged" | "envFileTouched" | "permissionsTouched" | "filesDeleted" | "newDependencies" | "networkCalls" | "gitHistory" | "failures" | "needsYou";

export interface Group {
  purpose: Purpose;
  created: number;
  modified: number;
  deleted: number;
  /** A few repo-relative paths (prefixed with the repo id when the run had more than one repository). */
  examples: string[];
}

export interface RepoDigest {
  repoId: string;
  /** `git` (snapshot against the tree), `log` (files the agent's tools touched) or `none`. */
  source: "git" | "log" | "none";
  fileCount: number;
  created: number;
  modified: number;
  deleted: number;
  additions: number;
  deletions: number;
  purposes: Purpose[];
  ios: boolean;
  android: boolean;
}

export interface Command {
  /** The first line of the command, masked and clipped. */
  text: string;
  failed: boolean;
  exitCode?: number;
}

export interface Decision {
  kind: "plan" | "todo" | "final";
  text: string;
  done: boolean;
}

export interface Check {
  code: CheckCode;
  repoIds: string[];
}

export interface Risk {
  code: RiskCode;
  count: number;
  /** Paths, package names, host names or git subcommands; never contents. */
  evidence: string[];
}

export interface RunDigest {
  version: number;
  runId: string;
  title: string;
  status: "running" | "done" | "failed" | "cancelled";
  startedMs: number;
  endedMs: number;
  generatedMs: number;
  fingerprint: { size: number; mtimeMs: number };
  fileCount: number;
  created: number;
  modified: number;
  deleted: number;
  additions: number;
  deletions: number;
  groups: Group[];
  repos: RepoDigest[];
  commands: Command[];
  commandCount: number;
  decisions: Decision[];
  checks: Check[];
  risks: Risk[];
  failureCount: number;
  failures: string[];
  needsYou: number;
  truncated: boolean;
}

/** A script of a repository's run catalog the "what to check" lines may name (names only, never bodies). */
export interface ScriptHint {
  /** `dev` | `start` | `test` */
  group: string;
  /** What is executed, e.g. `npm run dev`. */
  runner: string;
}
