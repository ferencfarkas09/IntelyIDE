// Hand-mirrored from crates/checks/src/types.rs (camelCase). Script bodies, secret values and .env values never appear.
export type CheckKind = "lint" | "test" | "syntax" | "swagger" | "cargo";

export interface CheckInfo {
  id: string;
  label: string;
  kind: CheckKind;
  /** The script name or tool, never a body. */
  runner: string;
  fileCount: number;
  disabled: string | null;
  note: string | null;
}

export type CheckStatus = "running" | "passed" | "failed" | "stopped";

export interface CheckRun {
  id: string;
  repoId: string;
  checkId: string;
  label: string;
  runner: string;
  status: CheckStatus;
  exitCode: number | null;
  startedAt: number;
  durationMs: number;
}

export interface LogChunk {
  runId: string;
  startSeq: number;
  lines: string[];
  reset: boolean;
}

export interface Finding {
  path: string;
  line: number;
  kind: string;
  /** The line with the matched text replaced by a marker. */
  preview: string;
}

export interface SecretScan {
  repoId: string;
  findings: Finding[];
  skipped: string[];
}

export interface EnvFile {
  path: string;
  kind: "example" | "real";
  environment: string;
  names: string[];
}

export interface MissingVar {
  name: string;
  usedIn: string[];
}

export interface RepoEnv {
  repoId: string;
  files: EnvFile[];
  declared: number;
  referenced: number;
  missing: MissingVar[];
  unused: string[];
  hasExample: boolean;
  missingTotal: number;
  scannedFiles: number;
  truncated: boolean;
}

export interface Presence {
  repoId: string;
  declared: boolean;
  referenced: boolean;
}

export interface NameRow {
  name: string;
  repos: Presence[];
}

export interface EnvReport {
  repos: RepoEnv[];
  names: NameRow[];
}

export interface ProcessAccess {
  allowed: boolean;
  jail: string;
  startable: boolean;
  reason?: string | null;
}
