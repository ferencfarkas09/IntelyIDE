import { createEffect, createSignal, For, on, onMount, Show } from "solid-js";
import { t } from "../../../i18n";
import { Button, Dialog, LiveRegion } from "../../../ui-kit";
import { isOn } from "../state";
import { createApplier } from "./apply";
import { cloudApi } from "./api";
import { ErrorSummary } from "./common";
import { cloudView, clearRun, currentRun, refreshCloud } from "./store";
import { DeployStep, DoneStep, NameStep, PrereqStep, ReviewStep, SignInStep, VerifyStep } from "./steps";
import { createWizard, STEPS, type StepId, type Wizard as WizardState } from "./wizardState";

const TITLE = {
  prereq: "remote.cloud.wiz.step.prereq",
  signin: "remote.cloud.wiz.step.signin",
  name: "remote.cloud.wiz.step.name",
  review: "remote.cloud.wiz.step.review",
  deploy: "remote.cloud.wiz.step.deploy",
  verify: "remote.cloud.wiz.step.verify",
  done: "remote.cloud.wiz.step.done",
} as const;

/** The 7-step set-up dialog ((design notes: remote-cloudflare-spec) 3.2). `startAt="review"` is the Update / redeploy entry. */
export function CloudWizard(props: { open: boolean; onClose: () => void; startAt?: StepId; onPair?: () => void }) {
  return (
    <Show when={cloudView()}>
      <WizardDialog {...props} />
    </Show>
  );
}

function WizardDialog(props: { open: boolean; onClose: () => void; startAt?: StepId; onPair?: () => void }) {
  const w: WizardState = createWizard(props.startAt ?? "prereq");
  const [confirmStop, setConfirmStop] = createSignal(false);
  let heading: HTMLHeadingElement | undefined;

  onMount(() => {
    if (!props.startAt) w.setStep(w.prereqOk() ? "signin" : "prereq");
    clearRun();
  });
  createEffect(on(w.step, (s) => s === "review" && void w.loadPreview(), { defer: false }));
  createEffect(on(w.step, () => queueMicrotask(() => heading?.focus()), { defer: true }));

  const applier = createApplier("cloudflare", () => w.view().profile?.url ?? null, () => {
    w.setApplied(true);
    w.setStep("done");
  });

  const idx = () => STEPS.indexOf(w.step());
  const running = () => currentRun()?.status === "running";
  const requestClose = () => (running() ? setConfirmStop(true) : close());
  const close = async () => {
    // "Sign out of wrangler when finished" is only honoured from the Done step's Close button.
    props.onClose();
  };
  const closeFromDone = async () => {
    const v = w.view();
    if (w.signOutAfter() && v.auth.authMode === "oauth" && v.auth.last?.loggedIn && v.jail !== "readOnly") {
      try {
        await cloudApi().logout();
      } catch {
        /* a failed sign-out never blocks closing; the status shows the login */
      }
      void refreshCloud().catch(() => {});
    }
    props.onClose();
  };
  const stopAndClose = async () => {
    const r = currentRun();
    if (r) await cloudApi().stop(r.runId).catch(() => {});
    setConfirmStop(false);
    props.onClose();
  };

  const canBack = () => idx() > 0 && w.step() !== "deploy" && w.step() !== "verify" && w.step() !== "done";
  const nextReason = (): string | null => {
    switch (w.step()) {
      case "prereq":
        return w.prereqOk() ? null : t("remote.cloud.wiz.needPrereq");
      case "signin":
        return w.accountChosen() ? null : t("remote.cloud.wiz.needAccount");
      case "name":
        return w.nameErr() ? t("remote.cloud.wiz.needName") : null;
      default:
        return null;
    }
  };
  const hasNext = () => ["prereq", "signin", "name"].includes(w.step());
  const go = (d: 1 | -1) => {
    w.setProblem(null);
    w.setStep(STEPS[idx() + d]);
  };

  return (
    <>
      <Dialog
        open={props.open}
        onClose={requestClose}
        title={t("remote.cloud.wiz.title")}
        size="lg"
        class="cloud-wizard"
        closeOnBackdrop={false}
        footer={
          <>
            <Show when={canBack()}>
              <Button variant="ghost" onClick={() => go(-1)} data-testid="wiz-back">
                {t("remote.cloud.back")}
              </Button>
            </Show>
            <Show when={hasNext()}>
              <Button variant="primary" aria-disabled={nextReason() ? "true" : undefined} aria-describedby={nextReason() ? "wiz-next-reason" : undefined} class="cloud-reason-btn" onClick={() => !nextReason() && go(1)} data-testid="wiz-next">
                {t("remote.cloud.next")}
              </Button>
            </Show>
            <Show when={w.step() === "done"}>
              <Button variant="primary" onClick={() => void closeFromDone()} data-testid="wiz-close">
                {t("remote.cloud.close")}
              </Button>
            </Show>
            <Show when={w.step() !== "done"}>
              <Button variant="ghost" onClick={requestClose} data-testid="wiz-cancel">
                {t("remote.cloud.cancel")}
              </Button>
            </Show>
          </>
        }
      >
        <div class="cloud-wiz">
          <ol class="cloud-wiz__steps" aria-label={t("remote.cloud.wiz.progress")}>
            <For each={STEPS}>
              {(s, i) => (
                <li aria-current={w.step() === s ? "step" : undefined} data-done={i() < idx() ? "" : undefined}>
                  <span class="cloud-wiz__n">{i() + 1}</span>
                  <span class="cloud-wiz__label">{t(TITLE[s])}</span>
                </li>
              )}
            </For>
          </ol>
          <LiveRegion message={t("remote.cloud.wiz.announce", { n: idx() + 1, total: STEPS.length, title: t(TITLE[w.step()]) })} />
          <h3 class="cloud-wiz__heading" tabIndex={-1} ref={heading}>
            {t(TITLE[w.step()])}
          </h3>
          <Show when={w.step() === "prereq"}>
            <PrereqStep w={w} />
          </Show>
          <Show when={w.step() === "signin"}>
            <SignInStep w={w} />
          </Show>
          <Show when={w.step() === "name"}>
            <NameStep w={w} />
          </Show>
          <Show when={w.step() === "review"}>
            <ReviewStep w={w} />
          </Show>
          <Show when={w.step() === "deploy"}>
            <DeployStep w={w} onBackToReview={() => w.setStep("review")} onNext={() => w.setStep("verify")} />
          </Show>
          <Show when={w.step() === "verify"}>
            <VerifyStep w={w} onUse={applier.start} using={applier.busy()} canUse />
            <ErrorSummary code={applier.code()} />
          </Show>
          <Show when={w.step() === "done"}>
            <DoneStep w={w} remoteOn={isOn()} onPair={() => (props.onClose(), props.onPair?.())} />
          </Show>
          <Show when={w.problem()}>
            <ErrorSummary code={w.problem()!.code} detail={w.problem()!.detail} />
            <Show when={w.step() === "review"}>
              <Button size="sm" variant="secondary" onClick={() => void w.loadPreview()} data-testid="review-again">
                {t("remote.cloud.review.again")}
              </Button>
            </Show>
          </Show>
          <Show when={nextReason()}>
            <p id="wiz-next-reason" class="cloud-note" data-testid="next-reason">
              {nextReason()}
            </p>
          </Show>
        </div>
      </Dialog>
      <Dialog
        open={confirmStop()}
        onClose={() => setConfirmStop(false)}
        title={t("remote.cloud.stopAsk.title")}
        size="sm"
        role="alertdialog"
        description={t("remote.cloud.stopAsk.body")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmStop(false)} data-autofocus data-testid="stop-keep">
              {t("remote.cloud.stopAsk.keep")}
            </Button>
            <Button variant="danger" onClick={() => void stopAndClose()} data-testid="stop-close">
              {t("remote.cloud.stopAsk.stop")}
            </Button>
          </>
        }
      />
      {applier.dialog()}
    </>
  );
}
