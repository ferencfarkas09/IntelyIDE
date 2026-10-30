// Mirrors crates/mobilehealth (serde camelCase).
export type Severity = "error" | "warn" | "info";
export type Confidence = "high" | "medium" | "low";
export type Status = "ok" | "missing" | "check";
export type Platform = "ios" | "android" | "cross" | "expo" | "env";

export interface Finding {
  /** Stable check id; the texts are the catalog keys `mobilehealth.f.<id>.title` and `.why`. */
  id: string;
  platform: Platform;
  severity: Severity;
  /** Relative to the repository root. */
  file: string | null;
  line: number | null;
  confidence: Confidence | null;
  /** Plain values the texts mention. Never a secret. */
  params: Record<string, string>;
  /** What to ask a coding agent. */
  prompt: string;
}

export interface Fact {
  key: string;
  value: string;
  file: string | null;
  line: number | null;
}

export interface ChecklistItem {
  id: string;
  platform: "ios" | "android";
  status: Status;
  file: string | null;
  params: Record<string, string>;
  prompt: string | null;
}

export interface Project {
  /** Relative to the repository root; empty = the root itself. */
  path: string;
  ios: boolean;
  android: boolean;
  reactNative: boolean;
  expo: boolean;
  flutter: boolean;
  facts: Fact[];
  findings: Finding[];
  checklist: ChecklistItem[];
}

export interface RepoHealth {
  repoId: string;
  detected: boolean;
  projects: Project[];
  /** `tooLarge:<file>`, `notRegular:<file>`, `unreadable:<file>`, `stoppedSearching`, `tooManyProjects`. */
  skipped: string[];
  /** When the tables behind the checks were last looked over. */
  data: { compat: string; store: string };
}
