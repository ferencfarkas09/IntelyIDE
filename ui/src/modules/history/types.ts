// Mirrors `intely_runindex::index` (hand-written: this extra has no bindings file). Texts are already scrubbed by the backend.
export type SnippetField = "title" | "prompt" | "reply" | "tool" | "file";

export interface Snippet {
  field: SnippetField;
  text: string;
  /** Highlighted ranges as `[start, end)` character offsets into `text`. */
  marks: [number, number][];
}

export interface SearchQuery {
  text: string;
  repo?: string;
  role?: string;
  model?: string;
  status?: string;
  fromMs?: number;
  toMs?: number;
  limit?: number;
}

export interface SearchHit {
  runId: string;
  title: string;
  role: string;
  model: string;
  repoIds: string[];
  status: "running" | "done" | "failed" | "cancelled" | (string & {});
  startedMs: number;
  endedMs: number;
  costUsd?: number;
  score: number;
  snippets: Snippet[];
}

export interface Counted {
  value: string;
  count: number;
}

export interface Facets {
  repos: Counted[];
  roles: Counted[];
  models: Counted[];
  statuses: Counted[];
}

export interface SearchOut {
  hits: SearchHit[];
  total: number;
  facets: Facets;
  indexed: number;
  tookMs: number;
}
