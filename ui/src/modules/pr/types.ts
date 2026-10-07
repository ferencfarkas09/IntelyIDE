// Hand-mirrored from crates/gitx/src/types.rs (camelCase).
export type CiState = "passing" | "failing" | "pending" | "none";
export type ReviewState = "approved" | "changesRequested" | "reviewRequired" | "none";

export interface GhStatus {
  installed: boolean;
  version: string | null;
  path: string | null;
  /** null when it was not asked (no network allowed, or gh is missing). */
  authenticated: boolean | null;
  /** The jail code (readOnly, testJail) that stops network calls right now. */
  blocked: string | null;
}

export interface PrSummary {
  number: number;
  title: string;
  state: string;
  isDraft: boolean;
  head: string;
  base: string;
  author: string;
  url: string;
  review: ReviewState;
  ci: CiState;
  checksPassed: number;
  checksFailed: number;
  checksPending: number;
  updatedAt: string;
}

export interface PrList {
  branch: string | null;
  current: PrSummary[];
  mine: PrSummary[];
}

export interface PrCheck {
  name: string;
  workflow: string;
  state: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel" | string;
  link: string | null;
}

export interface PrReview {
  author: string;
  state: string;
}

export interface PrDetail {
  summary: PrSummary;
  body: string;
  reviews: PrReview[];
  checks: PrCheck[];
}

export interface PlanCommit {
  sha: string;
  subject: string;
}

export interface Refusal {
  code: string;
  message: string;
}

export interface CreatePlan {
  repoName: string;
  head: string | null;
  base: string | null;
  bases: string[];
  upstream: string | null;
  unpushed: number;
  commits: PlanCommit[];
  title: string;
  body: string;
  draft: boolean;
  command: string;
  refusal: Refusal | null;
}

export interface CreateRequest {
  title: string;
  body: string;
  base: string;
  draft: boolean;
  confirmRepo: string;
  confirmHead: string;
}

export interface CreateResult {
  url: string;
  command: string;
}
