// Mirrors crates/l10n `release.rs` (serde camelCase; the changelog entry keeps the repo's own snake/lower shape).
export type Kind = "feature" | "improvement" | "fix" | "performance" | "security" | "internal";
export type Bump = "patch" | "minor" | "major";

export interface Commit {
  hash: string;
  subject: string;
  author: string;
  date: string;
  kind: Kind;
  scope: string | null;
  breaking: boolean;
}

export type Localized = Record<string, string>;

export interface Item {
  title: Localized;
  description?: Localized;
}

export interface Group {
  type: string;
  items: Item[];
}

export interface Entry {
  version: string;
  date: string;
  highlight: Localized;
  groups: Group[];
}

export interface Plan {
  versionFile: string | null;
  changelogPath: string | null;
  current: string;
  proposed: string;
  bump: Bump;
  baseKind: "tag" | "versionCommit" | "none";
  base: string | null;
  commits: Commit[];
  langs: string[];
  entry: Entry;
  tagHint: string | null;
  diff: string;
  notes: string[];
}

export interface ApplyRequest {
  version: string;
  entry: Entry | null;
  changelogPath: string | null;
}
