// Hand-mirrored from crates/gitx/src/types.rs (camelCase).
export type DoctorLevelName = "ok" | "info" | "warn" | "error";

export interface DoctorItem {
  name: string;
  count: number | null;
  bytes: number | null;
  ageMinutes: number | null;
}

export interface DoctorCheck {
  /** tools, credentials, path, repo, disk, leftovers */
  group: string;
  level: DoctorLevelName;
  code: string;
  params: Record<string, string>;
  items: DoctorItem[];
  repoId: string | null;
  /** A safe, reversible action: refreshEnv. */
  fix: string | null;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  generatedAt: number;
}
