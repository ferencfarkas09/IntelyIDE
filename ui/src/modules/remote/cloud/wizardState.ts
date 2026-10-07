import { createMemo, createSignal } from "solid-js";
import { cloudApi } from "./api";
import { messageOf } from "./common";
import { defaultWorkerName, deployBlock, errorCodeOf, errorDetailOf, nameProblem, safeLoginUrl } from "./logic";
import { currentLog, currentRun, followRun, refreshCloud, cloudView, clearRun } from "./store";
import type { AuthMode, CloudPlan, CloudRun, CloudView, DeployPreview, RelayCheck } from "./types";

export const STEPS = ["prereq", "signin", "name", "review", "deploy", "verify", "done"] as const;
export type StepId = (typeof STEPS)[number];

export interface Problem {
  code: string;
  detail: string | null;
}

/** All wizard state in one place; the step components read and write it. Nothing here calls a command until a button does. */
export function createWizard(start: StepId) {
  const [step, setStep] = createSignal<StepId>(start);
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal<Problem | null>(null);
  // step 2
  const [authChoice, setAuthChoice] = createSignal<AuthMode>("oauth");
  const [device, setDevice] = createSignal(false);
  const [token, setToken] = createSignal("");
  const [manualAccount, setManualAccount] = createSignal("");
  const [signOutAfter, setSignOutAfter] = createSignal(true);
  // step 3
  const profileName = cloudView()?.profile?.workerName;
  const [name, setName] = createSignal(profileName ?? defaultWorkerName());
  const [push, setPush] = createSignal(true);
  // step 4
  const [preview, setPreview] = createSignal<DeployPreview | null>(null);
  const [ack, setAck] = createSignal(false);
  const [typed, setTyped] = createSignal("");
  const [typedOverwrite, setTypedOverwrite] = createSignal("");
  const [ackUnverified, setAckUnverified] = createSignal(false);
  /** The plan Rust holds for this review: the exact command shown here and the one-time nonce the deploy sends back. */
  const [plan, setPlan] = createSignal<CloudPlan | null>(null);
  // step 6
  const [check, setCheck] = createSignal<RelayCheck | null>(null);
  const [unpairAsk, setUnpairAsk] = createSignal<number | null>(null);
  const [applied, setApplied] = createSignal(false);

  const fail = (e: unknown) => setProblem({ code: errorCodeOf(e), detail: errorDetailOf(e) });
  /** Runs one command with the busy flag and the problem line. */
  const guarded = async <T,>(op: () => Promise<T>): Promise<T | undefined> => {
    setProblem(null);
    setBusy(true);
    try {
      return await op();
    } catch (e) {
      fail(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  let lastView = cloudView()!;
  /** The dialog outlives a status reset for a moment (exit animation); keep the last known view instead of reading null. */
  const view = (): CloudView => (lastView = cloudView() ?? lastView);
  const nameErr = createMemo(() => nameProblem(name()));
  const accountChosen = (): boolean => !!view().auth.last?.loggedIn && !!view().auth.last?.chosenAccountId;
  const prereqOk = (): boolean => {
    const k = view().kit;
    return view().secretStoreDurable && k.found && k.wranglerOk && k.nodeOk && k.pnpmOk && k.distBuilt;
  };

  const block = () => {
    const p = preview();
    if (!p) return "ack" as const;
    return deployBlock({
      ack: ack(),
      typed: typed(),
      typedOverwrite: typedOverwrite(),
      workerName: p.workerName,
      nameCheck: p.nameCheck,
      kitDirtyFiles: p.kitDirtyFiles,
      needsUnverifiedAck: p.needsUnverifiedAck,
      ackUnverified: ackUnverified(),
    });
  };

  /** A fresh single-use preview. `keepConfirm` (retry of the same name) keeps what the user already typed. */
  const loadPreview = (keepConfirm = false) =>
    guarded(async () => {
      setPreview(null);
      setPlan(null);
      setAckUnverified(false);
      if (!keepConfirm) {
        setAck(false);
        setTyped("");
        setTypedOverwrite("");
      }
      const p = await cloudApi().preview({ workerName: name(), push: push() });
      // the command the review shows is the one in the plan Rust holds: both arrive together, so the review never shows an empty command
      const pl = await cloudApi().plan({ op: "deploy", previewId: p.previewId });
      setPlan(pl);
      setPreview(p);
    });
  const retryDeploy = async () => {
    await loadPreview(true);
    if (preview()) await runDeploy();
  };

  const runDeploy = async (): Promise<CloudRun | undefined> => {
    const p = preview();
    if (!p) return;
    clearRun();
    setStep("deploy");
    return guarded(async () => {
      // a plan is good for a few minutes only: ask again when it ran out while the user read the review
      let pl = plan();
      if (!pl || pl.expiresAt * 1000 <= Date.now()) {
        pl = await cloudApi().plan({ op: "deploy", previewId: p.previewId });
        setPlan(pl);
      }
      const planId = pl.planId;
      const h = followRun(() => cloudApi().deploy({ previewId: p.previewId, confirmName: typed(), overwritePhrase: typedOverwrite() || undefined, planId, acknowledgeUnverified: ackUnverified() }));
      await h.started;
      return h.done;
    });
  };

  return {
    step, setStep, busy, setBusy, problem, setProblem, guarded, fail,
    authChoice, setAuthChoice, device, setDevice, token, setToken, manualAccount, setManualAccount, signOutAfter, setSignOutAfter,
    name, setName, push, setPush, nameErr,
    preview, setPreview, plan, ack, setAck, ackUnverified, setAckUnverified, typed, setTyped, typedOverwrite, setTypedOverwrite, block, loadPreview, runDeploy, retryDeploy,
    check, setCheck, unpairAsk, setUnpairAsk, applied, setApplied,
    view, accountChosen, prereqOk,
    run: currentRun, log: currentLog,
    loginUrl: () => safeLoginUrl(currentRun()?.loginUrl ?? null),
    refresh: refreshCloud,
    messageOf,
  };
}
export type Wizard = ReturnType<typeof createWizard>;
