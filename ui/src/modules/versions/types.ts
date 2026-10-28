// Mirrors crates/versions (serde camelCase).
export type Kind = "packageJson" | "pbxproj" | "infoPlist" | "gradle" | "cargo" | "tauri" | "expo" | "pyproject" | "pubspec";
/** The version people read, or the build number a store counts up. */
export type Role = "version" | "build";
export type Bump = "patch" | "minor" | "major";

export interface Field {
  /** `<path>#<key>`: sent back in a Change. */
  id: string;
  path: string;
  kind: Kind;
  key: string;
  role: Role;
  value: string;
  occurrences: number;
  /** The occurrences in the file do not all hold the same value; a change sets all of them. */
  mixed: boolean;
  /** Written bare, not in quotes: only digits fit there (a JSON number, a Gradle versionCode, a pubspec build number). */
  numeric: boolean;
  /** Files that change together with this one (the package-lock.json beside a package.json). */
  companions: string[];
}

export interface RepoVersions {
  repoId: string;
  fields: Field[];
  truncated: boolean;
  skipped: string[];
}

export interface Change {
  id: string;
  from: string;
  to: string;
}

export interface FilePlan {
  path: string;
  diff: string;
}
