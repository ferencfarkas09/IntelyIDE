// The Sentry views' data: what the `sentry_*` commands answer. Hand-written like the rest of the agent-UX contract; the Rust side is
// `crates/sentry/src/types.rs` (camelCase on the wire).

/** A failure the view can explain. `code` is stable; `retryAfterSeconds` rides in the engine error's detail for `rateLimited`. */
export interface SentryProblem {
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

export interface SentryStatus {
  baseUrl: string;
  org: string;
  hasToken: boolean;
  /** An organization and a token are set: the issue list can be asked for. */
  configured: boolean;
}

export interface SentryConnection {
  ok: boolean;
  orgName: string | null;
  /** Who the token belongs to; null for a token that is not a person's (it cannot take issues). */
  user: string | null;
  problem: SentryProblem | null;
}

export interface SentryProject {
  id: string;
  slug: string;
  name: string;
}

export interface SentryActor {
  kind: "user" | "team" | string;
  id: string;
  name: string;
}

export interface SentryIssue {
  id: string;
  /** The readable id, `SHOP-1A`. */
  shortId: string;
  title: string;
  culprit: string;
  level: "fatal" | "error" | "warning" | "info" | "debug" | string;
  status: "unresolved" | "resolved" | "ignored" | string;
  /** Events in the selected period. */
  count: number;
  userCount: number;
  firstSeen: string;
  lastSeen: string;
  permalink: string;
  project: SentryProject | null;
  assignedTo: SentryActor | null;
  errorType: string | null;
  errorValue: string | null;
  isUnhandled: boolean;
}

export interface SentryPage {
  issues: SentryIssue[];
  nextCursor: string | null;
}

export type StatusFilter = "unresolved" | "resolved" | "ignored" | "all";
export type PeriodFilter = "24h" | "7d" | "14d" | "30d" | "90d";
export type SortFilter = "date" | "freq" | "new" | "user";

/** What the list is asked for. Empty fields are "no such filter". */
export interface SentryQuery {
  query: string;
  status: StatusFilter;
  period: PeriodFilter;
  sort: SortFilter;
  project?: string | null;
  cursor?: string | null;
  limit?: number | null;
}

export interface SentryTag {
  key: string;
  value: string;
}

export interface SentryFrame {
  filename: string;
  function: string;
  line: number | null;
  inApp: boolean;
  context: { line: number; code: string }[];
}

export interface SentryException {
  kind: string;
  value: string;
  /** Oldest call first, the failing one last. */
  frames: SentryFrame[];
}

export interface SentryCrumb {
  timestamp: string;
  category: string;
  message: string;
  level: string;
}

export interface SentryEvent {
  eventId: string;
  dateCreated: string;
  platform: string;
  release: string | null;
  environment: string | null;
  message: string;
  exceptions: SentryException[];
  breadcrumbs: SentryCrumb[];
  tags: SentryTag[];
  requestUrl: string | null;
}

export interface SentryDetail {
  issue: SentryIssue;
  /** Null when the newest event could not be read. */
  event: SentryEvent | null;
}
