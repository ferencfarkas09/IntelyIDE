// Mirrors `intely_runindex::night` and `intely_runindex::brief` (hand-written: this extra has no bindings file).
export type ItemState = "queued" | "running" | "done" | "failed" | "stopped" | "skipped";

export interface NightItem {
  id: string;
  roleId: string;
  prompt: string;
  repoIds: string[];
  maxMinutes: number;
  maxTokens: number;
  state: ItemState;
  runId?: string;
  startedMs?: number;
  endedMs?: number;
  tokensUsed: number;
  /** `timeBudget`, `tokenBudget`, `userStop`, `interrupted`, or an engine error code. */
  reason?: string;
  /** Why a queued item still waits (a busy writer, no free slot). */
  waiting?: string;
}

export type Paused = "battery" | "readOnly";

export interface NightView {
  items: NightItem[];
  armed: boolean;
  armedMs?: number;
  cap: number;
  paused?: Paused | null;
  onBattery: boolean;
  readOnly: boolean;
  nowMs: number;
}

export interface NewItem {
  roleId: string;
  prompt: string;
  repoIds: string[];
  maxMinutes: number;
  maxTokens: number;
}

export interface FileChange {
  path: string;
  change: "modified" | "created" | "deleted";
  additions: number;
  deletions: number;
}

export interface RepoChange {
  repoId: string;
  files: FileChange[];
  fileCount: number;
  additions: number;
  deletions: number;
  /** `noSnapshot` | `gitUnavailable` when there is nothing to show. */
  note?: string;
}

export interface Failure {
  kind: "tool" | "error" | "stop";
  text: string;
}

export interface Need {
  kind: "permission" | "question";
  text: string;
  ts: number;
}

export interface BriefRun {
  runId: string;
  title: string;
  role: string;
  model: string;
  status: "running" | "done" | "failed" | "cancelled" | (string & {});
  startedMs: number;
  endedMs: number;
  repos: RepoChange[];
  failures: Failure[];
  failureCount: number;
  needsYou: Need[];
  costUsd?: number;
  tokens: number;
}

export interface Brief {
  generatedMs: number;
  runs: BriefRun[];
  totals: { runs: number; failed: number; files: number; additions: number; deletions: number; needsYou: number; costUsd?: number };
}

export interface NightErrorBody {
  code: string;
  message: string;
}
