import { createSignal } from "solid-js";
import type { Decision } from "./hunks";
import type { FileApply } from "./files";

/** Review state lives here, not in the tab component: the centre area remounts when the left panel toggles. */
export interface ReviewState {
  decisions: Record<string, Decision>;
  /** The reviewer agent started from this tab. */
  reviewerId?: string;
  applied: FileApply[];
}

const EMPTY: ReviewState = { decisions: {}, applied: [] };
const [states, setStates] = createSignal<Record<string, ReviewState>>({});

export const reviewState = (runId: string): ReviewState => states()[runId] ?? EMPTY;

function patch(runId: string, f: (s: ReviewState) => ReviewState): void {
  setStates((all) => ({ ...all, [runId]: f(all[runId] ?? EMPTY) }));
}

export const setDecisions = (runId: string, hunkIds: readonly string[], d: Decision): void =>
  patch(runId, (s) => ({ ...s, decisions: { ...s.decisions, ...Object.fromEntries(hunkIds.map((id) => [id, d])) } }));
export const setReviewer = (runId: string, reviewerId: string): void => patch(runId, (s) => ({ ...s, reviewerId }));
export const setApplied = (runId: string, applied: FileApply[]): void => patch(runId, (s) => ({ ...s, applied }));
export const resetReviewStates = (): void => void setStates({});
