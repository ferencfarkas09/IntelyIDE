import { call, notImplemented } from "./rpc";
import type {
  BlameCaret,
  BlameLine,
  BranchMatrix,
  Bundle,
  BundleLink,
  CommitDetail,
  GraphRow,
  LogFilters,
  LogPage,
  MessageCheck,
  MessageDraft,
  MessageStyle,
  OpOutcome,
  RebasePlan,
  SameBranchResult,
  SelectedPath,
} from "../bindings/graph";
import type { RepoId } from "./index";

export type * from "../bindings/graph";

/** A bundle as the UI lists it (recorded or heuristic). */
export type BundleInfo = Bundle;

/** The rebase part of `OpOutcome`: `idle` when no rebase is in progress. */
export interface RebaseStatus {
  state: "idle" | "conflict" | "stopped";
  step: number;
  total: number;
  conflicts: string[];
}

export interface GraphIpc {
  /**
   * Newest first by commit time, interleaved across `repoIds`, 500 per page. Pass the previous `nextCursor` (and the same
   * filters) for the next page. Rows carry the lane drawing of their repo's own graph.
   */
  logPage(repoIds: RepoId[], cursor?: string, filters?: LogFilters, limit?: number): Promise<LogPage>;
  commitDetail(repoId: RepoId, oid: string): Promise<CommitDetail>;
  /** The working-tree file, or the file at `rev`; cached per file and revision. */
  blame(repoId: RepoId, path: string, rev?: string): Promise<BlameLine[]>;
  /** Author, relative time and subject of one line (1-based), from the same cache as `blame`. */
  blameCaret(repoId: RepoId, path: string, line: number, rev?: string): Promise<BlameCaret>;
  fileHistory(repoId: RepoId, path: string): Promise<GraphRow[]>;
  /** The commits of `onto..HEAD` as an all-pick plan, oldest first; edit `action` / `message` and order, then `rebaseRun`. */
  rebasePlan(repoId: RepoId, onto: string): Promise<RebasePlan>;
  /** Refused on protected / live branches unless `confirmLive` is the branch name, typed by the human. */
  rebaseRun(plan: RebasePlan, confirmLive?: string): Promise<OpOutcome>;
  rebaseAbort(repoId: RepoId): Promise<OpOutcome>;
  rebaseContinue(repoId: RepoId): Promise<OpOutcome>;
  /** Whether a rebase or cherry-pick is in progress, and its conflicts. */
  opState(repoId: RepoId): Promise<OpOutcome>;
  /** `opState` narrowed to a rebase: anything else in progress reads as `idle`. */
  rebaseStatus(repoId: RepoId): Promise<RebaseStatus>;
  /** Removes hunk `index` of the file's working-tree diff. Not implemented by the backend yet. */
  revertHunk(repoId: RepoId, path: string, index: number): Promise<void>;
  cherryPick(repoId: RepoId, oids: string[], confirmLive?: string): Promise<OpOutcome>;
  cherryPickAbort(repoId: RepoId): Promise<OpOutcome>;
  cherryPickContinue(repoId: RepoId): Promise<OpOutcome>;
  /** Per repo current branch, upstream and ahead/behind, and which repos have which branch. */
  branchMatrix(repoIds?: RepoId[]): Promise<BranchMatrix>;
  /** All-or-nothing: if any repo cannot, `applied` is false and nothing changed. */
  sameBranchCreate(repoIds: RepoId[], name: string, start?: string): Promise<SameBranchResult>;
  sameBranchSwitch(repoIds: RepoId[], name: string): Promise<SameBranchResult>;
  /** Recorded bundles first, then heuristic ones (same subject in several repos within `windowMs`, default 10 min). */
  bundles(repoIds?: RepoId[], windowMs?: number): Promise<Bundle[]>;
  /** Links the commits of one coordinated commit (one per repo, at least two). IDE state only: git is not touched. */
  bundleRecord(links: BundleLink[], name?: string): Promise<Bundle>;
  bundleRemove(id: string): Promise<void>;
  validateMessage(message: string, style: MessageStyle): Promise<MessageCheck>;
  messageTemplate(style: MessageStyle, subject?: string): Promise<string>;
  /** Just the text of `draftMessageDetailed`. */
  draftMessage(repoId: RepoId, selection: SelectedPath[]): Promise<string>;
  /** A message draft for the selected changes: model-written when a utility model is available, else template-only. */
  draftMessageDetailed(repoId: RepoId, selection: SelectedPath[]): Promise<MessageDraft>;
}

export function createTauriGraph(): GraphIpc {
  return {
    logPage: (repoIds, cursor, filters, limit) => call("graph_log_page", { repoIds, cursor, filters, limit }),
    commitDetail: (repoId, oid) => call("graph_commit_detail", { repoId, oid }),
    blame: (repoId, path, rev) => call("graph_blame", { repoId, path, rev }),
    blameCaret: (repoId, path, line, rev) => call("graph_blame_caret", { repoId, path, line, rev }),
    fileHistory: (repoId, path) => call("graph_file_history", { repoId, path }),
    rebasePlan: (repoId, onto) => call("graph_rebase_plan", { repoId, onto }),
    rebaseRun: (plan, confirmLive) => call("graph_rebase_run", { plan, confirmLive }),
    rebaseAbort: (repoId) => call("graph_rebase_abort", { repoId }),
    rebaseContinue: (repoId) => call("graph_rebase_continue", { repoId }),
    opState: (repoId) => call("graph_op_state", { repoId }),
    rebaseStatus: async (repoId) => {
      const o = await call<OpOutcome>("graph_op_state", { repoId });
      return { state: o.kind === "rebase" && o.status !== "idle" && o.status !== "done" ? o.status : "idle", step: o.step, total: o.total, conflicts: o.conflictFiles };
    },
    revertHunk: () => notImplemented("graph.revertHunk"),
    cherryPick: (repoId, oids, confirmLive) => call("graph_cherry_pick", { repoId, oids, confirmLive }),
    cherryPickAbort: (repoId) => call("graph_cherry_pick_abort", { repoId }),
    cherryPickContinue: (repoId) => call("graph_cherry_pick_continue", { repoId }),
    branchMatrix: (repoIds) => call("graph_branch_matrix", { repoIds }),
    sameBranchCreate: (repoIds, name, start) => call("graph_same_branch_create", { repoIds, name, start }),
    sameBranchSwitch: (repoIds, name) => call("graph_same_branch_switch", { repoIds, name }),
    bundles: (repoIds, windowMs) => call("graph_bundles", { repoIds, windowMs }),
    bundleRecord: (links, name) => call("graph_bundle_record", { links, name }),
    bundleRemove: (id) => call("graph_bundle_remove", { id }),
    validateMessage: (message, style) => call("graph_validate_message", { message, style }),
    messageTemplate: (style, subject) => call("graph_message_template", { style, subject }),
    draftMessage: async (repoId, selection) => (await call<MessageDraft>("graph_draft_message", { repoId, selection })).message,
    draftMessageDetailed: (repoId, selection) => call("graph_draft_message", { repoId, selection }),
  };
}
