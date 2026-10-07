import { t } from "../../i18n";
import { batch, createMemo } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { getRun, repoName, runPush } from "../../store/actions";
import { snapshots } from "../../store/snapshots";
import { workspace } from "../../store/workspace";
import { ipc, type ChangedFile, type OpResult, type OutgoingInfo, type RepoId } from "../../ipc";
import { canConfirmForce, defaultChecks, forceRows, isPushable, buildPushRequest, liveConfirmed, liveRows, type ForceRow, type LiveRow } from "./logic";
import { pushTags, runGitHooks } from "./settings";

export type FilesState = { status: "loading" } | { status: "ready"; files: ChangedFile[] } | { status: "error"; message: string };

export interface TargetEdit {
  repoId: RepoId;
  remote: string;
  branch: string;
}

interface State {
  phase: "idle" | "loading" | "ready" | "error";
  error?: string;
  plans: OutgoingInfo[];
  checks: Record<RepoId, boolean>;
  expanded: Record<RepoId, boolean>;
  selected: { repoId: RepoId; oid: string } | null;
  files: Record<string, FilesState>;
  /** Typed confirmation per repo for live branches. */
  confirm: Record<RepoId, string>;
  runId?: string;
  /** Message of a rejected `push_start` or target save. */
  notice?: string;
}

const message = (e: unknown): string => (typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e));

/** State and operations of the push dialog. The component only renders it. */
export function createPushModel() {
  const [state, setState] = createStore<State>({ phase: "idle", plans: [], checks: {}, expanded: {}, selected: null, files: {}, confirm: {} });
  let preselected: readonly RepoId[] | undefined;
  let loadToken = 0;

  const repoIds = (): RepoId[] => [...(workspace()?.repos ?? [])].sort((a, b) => a.order - b.order).map((r) => r.id);

  async function load(refetch: boolean): Promise<void> {
    const token = ++loadToken;
    // On a reload (after a target edit) keep what the user already ticked.
    const previous = state.plans.length ? { ...state.checks } : null;
    setState({ phase: "loading", error: undefined });
    try {
      const plans = await ipc.pushPlan(repoIds(), refetch);
      if (token !== loadToken) return;
      batch(() => {
        const checks = defaultChecks(plans, preselected);
        if (previous) for (const p of plans) if (isPushable(p) && p.repoId in previous) checks[p.repoId] = previous[p.repoId];
        setState({
          phase: "ready",
          plans,
          checks,
          expanded: Object.fromEntries(plans.map((p) => [p.repoId, state.expanded[p.repoId] ?? isPushable(p)])),
        });
        const first = plans.find((p) => checks[p.repoId] && p.commits.length);
        if (first && !state.selected) selectCommit(first.repoId, first.commits[0].oid);
      });
    } catch (e) {
      if (token === loadToken) setState({ phase: "error", error: message(e) });
    }
  }

  /** Called whenever the dialog opens. */
  function open(ids?: readonly RepoId[]): void {
    preselected = ids;
    setState({ plans: [], checks: {}, expanded: {}, selected: null, files: {}, confirm: {}, runId: undefined, notice: undefined, phase: "idle" });
    void load(false);
  }

  function selectCommit(repoId: RepoId, oid: string): void {
    setState("selected", { repoId, oid });
    const key = `${repoId}:${oid}`;
    if (state.files[key]?.status === "ready") return;
    setState("files", key, { status: "loading" });
    ipc
      .pushCommitFiles(repoId, oid)
      .then((files) => setState("files", key, { status: "ready", files }))
      .catch((e) => setState("files", key, { status: "error", message: message(e) }));
  }

  const toggleRepo = (repoId: RepoId, on: boolean): void => {
    const plan = state.plans.find((p) => p.repoId === repoId);
    if (plan && isPushable(plan)) setState("checks", repoId, on);
  };
  const toggleExpanded = (repoId: RepoId): void => setState("expanded", repoId, (v) => !v);

  async function saveTargets(edits: readonly TargetEdit[]): Promise<boolean> {
    try {
      for (const edit of edits) {
        const plan = state.plans.find((p) => p.repoId === edit.repoId);
        if (plan && (plan.remote !== edit.remote || plan.remoteBranch !== edit.branch)) await ipc.setPushTarget(edit.repoId, plan.local, edit.remote.trim(), edit.branch.trim());
      }
      setState("notice", undefined);
      await load(false);
      return true;
    } catch (e) {
      setState("notice", message(e));
      return false;
    }
  }

  const checkedPlans = createMemo(() => state.plans.filter((p) => state.checks[p.repoId] && isPushable(p)));
  const rows = (): ForceRow[] => forceRows(state.plans, state.checks, repoName, snapshots());
  const live = (): LiveRow[] => liveRows(state.plans, state.checks, repoName);
  const setConfirm = (repoId: RepoId, value: string): void => setState("confirm", repoId, value);
  /** A live branch is never pushed without its typed name, and never with hooks off. */
  const liveBlocked = (): string | null => {
    const rows = live();
    if (!rows.length) return null;
    if (!runGitHooks()) return t("push.live.hooks");
    return liveConfirmed(rows, state.confirm) ? null : t("push.live.type");
  };
  const progress = (repoId: RepoId) => (state.runId ? getRun(state.runId)?.repos[repoId] : undefined);

  /** Pushes the ticked repos; with `force`, every one of them with `--force-with-lease`. */
  async function start(force: boolean): Promise<OpResult | null> {
    const targets = checkedPlans();
    if (!targets.length || state.runId) return null;
    const request = buildPushRequest({
      runId: crypto.randomUUID(),
      plans: state.plans,
      checks: state.checks,
      tags: pushTags(),
      runHooks: runGitHooks(),
      force: force ? targets.map((p) => p.repoId) : undefined,
      confirm: state.confirm,
    });
    setState({ runId: request.runId, notice: undefined });
    const result = await runPush(request, { fresh: true });
    setState(produce((s) => void (s.runId = undefined)));
    return result;
  }

  return {
    state,
    open,
    reload: () => load(true),
    selectCommit,
    toggleRepo,
    toggleExpanded,
    saveTargets,
    start,
    checkedPlans,
    forceRows: rows,
    liveRows: live,
    setConfirm,
    liveBlocked,
    canConfirmForce,
    progress,
    running: () => state.runId !== undefined,
  };
}

export type PushModel = ReturnType<typeof createPushModel>;
