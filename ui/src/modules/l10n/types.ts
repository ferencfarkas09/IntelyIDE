// Mirrors crates/l10n (serde camelCase). Keep in step with `analyze.rs`, `draft.rs`, `edit.rs`.
export type CellState = "ok" | "missing" | "placeholder" | "plural" | "noFile";

export interface Todo {
  path: string[];
  reference: string;
}

export interface Cell {
  state: CellState;
  note?: string;
  todo: Todo[];
}

export interface Row {
  key: string;
  reason: "added" | "changed" | "used";
  plural: boolean;
  refLang: string;
  reference: string;
  files: string[];
  cells: Record<string, Cell>;
}

export interface GroupReport {
  group: string;
  langs: string[];
  files: Record<string, string>;
  rows: Row[];
  truncated: boolean;
}

export interface FileBadge {
  path: string;
  missing: number;
  problems: number;
}

export interface Report {
  layout: "admin" | "mobile" | "pos" | "none";
  langs: string[];
  reference: string | null;
  catalogs: number;
  changed: number;
  groups: GroupReport[];
  undefined: { key: string; files: string[] }[];
  badges: FileBadge[];
  totals: { lang: string; missing: number; problems: number }[];
  skipped: number;
}

export interface DraftItem {
  id: string;
  lang: string;
  reference: string;
  refLang: string;
}

export interface Drafted {
  id: string;
  text: string;
  valid: boolean;
  note?: string | null;
}

export interface Edit {
  rel: string;
  path: string[];
  value: string;
}

export interface Applied {
  written: number;
  files: string[];
}

/** One line of the review list: a key to write in one language. */
export interface Proposal {
  id: string;
  group: string;
  rel: string;
  lang: string;
  key: string;
  path: string[];
  reference: string;
  refLang: string;
  text: string;
  valid: boolean;
  note?: string;
  /** The human's decision: only accepted proposals are ever written. */
  decision: "pending" | "accepted" | "rejected";
}
