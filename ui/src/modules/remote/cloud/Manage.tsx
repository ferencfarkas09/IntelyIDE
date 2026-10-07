import { createEffect, createSignal, For, on, Show } from "solid-js";
import { t } from "../../../i18n";
import { Button, Checkbox, Dialog, Ellipsis, Input, Menu, toast, type MenuEntry } from "../../../ui-kit";
import { panic } from "../actions";
import { isOn } from "../state";
import { createApplier } from "./apply";
import { cloudApi } from "./api";
import { ErrorSummary, TypedConfirm } from "./common";
import { errorCodeOf } from "./logic";
import { followRun, refreshCloud } from "./store";
import type { CloudPlan, CloudView } from "./types";

type Kind = "rotateSigning" | "rotateVapid" | "rotateCancelSigning" | "rotateCancelVapid" | "token" | "logout" | "stop" | "rollback" | "forget" | "remove" | "runbook";

/** Manage menu of an existing profile ((design notes: remote-cloudflare-spec) 3.3). Every item that goes outward asks first. */
export function ManageMenu(props: { view: CloudView; disabled: boolean; onUpdate: () => void }) {
  const [kind, setKind] = createSignal<Kind | null>(null);
  const close = () => setKind(null);
  const prof = () => props.view.profile!;
  const items = (): MenuEntry[] => [
    { label: t("remote.cloud.manage.update"), onSelect: props.onUpdate },
    { type: "separator" },
    { label: t("remote.cloud.manage.rotateSigning"), onSelect: () => setKind("rotateSigning") },
    { label: t("remote.cloud.manage.rotateVapid"), onSelect: () => setKind("rotateVapid") },
    ...(props.view.keys.signingRotationPending ? [{ label: t("remote.cloud.manage.rotateCancelSigning"), onSelect: () => setKind("rotateCancelSigning") } as MenuEntry] : []),
    ...(props.view.keys.vapidRotationPending ? [{ label: t("remote.cloud.manage.rotateCancelVapid"), onSelect: () => setKind("rotateCancelVapid") } as MenuEntry] : []),
    { label: t("remote.cloud.manage.rotateIdentity"), onSelect: () => void panic() },
    ...(props.view.auth.authMode === "token" ? [{ label: t("remote.cloud.manage.replaceToken"), onSelect: () => setKind("token") } as MenuEntry] : []),
    { label: t("remote.cloud.manage.logout"), onSelect: () => setKind("logout"), disabled: !props.view.auth.last?.loggedIn || props.view.auth.authMode === "token" },
    { type: "separator" },
    { label: t("remote.cloud.manage.stop"), onSelect: () => setKind("stop") },
    { label: t("remote.cloud.manage.rollback"), onSelect: () => setKind("rollback") },
    { label: t("remote.cloud.manage.forget"), onSelect: () => setKind("forget"), danger: true },
    ...(props.view.removeEnabled ? [{ label: t("remote.cloud.manage.remove"), onSelect: () => setKind("remove"), danger: true } as MenuEntry] : []),
    { type: "separator" },
    { label: t("remote.cloud.manage.runbook"), onSelect: () => setKind("runbook") },
  ];

  /** Follows a wrangler run started from a dialog and reports the outcome as a toast. */
  const runAndToast = async (start: () => ReturnType<typeof followRun>, okKey: "remote.cloud.toast.rolledBack" | "remote.cloud.toast.removed") => {
    const h = start();
    await h.started;
    const r = await h.done;
    if (r.status !== "ok") throw { code: r.error?.code ?? "deployFailed" };
    toast.show({ title: t(okKey), tone: "ok", duration: 4000 });
    await refreshCloud();
  };

  // Rollback and remove run only from a plan Rust holds: the dialog shows the plan's command and sends its nonce back.
  const [plan, setPlan] = createSignal<CloudPlan | null>(null);
  const [planCode, setPlanCode] = createSignal<string | null>(null);
  const planOp = (): "rollback" | "remove" | null => (kind() === "rollback" || kind() === "remove" ? (kind() as "rollback" | "remove") : null);
  createEffect(
    on(planOp, (op) => {
      setPlan(null);
      setPlanCode(null);
      if (op) cloudApi().plan({ op }).then(setPlan, (e) => setPlanCode(errorCodeOf(e)));
    }),
  );
  /** The plan shown, or a fresh one when it ran out while the dialog stayed open. */
  const planFor = async (op: "rollback" | "remove"): Promise<CloudPlan> => {
    const p = plan();
    if (p && p.op === op && p.expiresAt * 1000 > Date.now()) return p;
    const fresh = await cloudApi().plan({ op });
    setPlan(fresh);
    return fresh;
  };
  const PlanCommand = () => (
    <>
      <Show when={plan()} fallback={<p class="cloud-note" data-testid="plan-loading">{planCode() ? "" : t("remote.cloud.plan.loading")}</p>}>
        {(p) => (
          <>
            <pre class="cloud-cmd" dir="ltr" data-testid="plan-cmd">{p().argv.join(" ")}</pre>
            <p class="cloud-note">
              {t("remote.cloud.review.dir")} <span class="cloud-mono" dir="ltr">{p().cwd}</span>
            </p>
          </>
        )}
      </Show>
      <ErrorSummary code={planCode()} />
    </>
  );

  const [token, setToken] = createSignal("");
  const [wipe, setWipe] = createSignal(true);
  const [dlgCode, setDlgCode] = createSignal<string | null>(null);
  const [dlgBusy, setDlgBusy] = createSignal(false);
  const stopApplier = createApplier("local", () => "ws://local.invalid", () => (close(), void refreshCloud()), async (confirmUnpair) => {
    if (wipe() && isOn()) await panic(true);
    await cloudApi().apply({ mode: "local", confirmUnpair });
  });
  const simple = async (op: () => Promise<void>) => {
    setDlgBusy(true);
    setDlgCode(null);
    try {
      await op();
      close();
      await refreshCloud();
    } catch (e) {
      setDlgCode(errorCodeOf(e));
    } finally {
      setDlgBusy(false);
    }
  };

  return (
    <>
      <Menu
        aria-label={t("remote.cloud.manage.label")}
        placement="bottom-end"
        items={items()}
        trigger={(tp) => (
          <Button {...tp} size="sm" variant="secondary" iconRight={Ellipsis} disabled={props.disabled} data-testid="manage">
            {t("remote.cloud.manage.label")}
          </Button>
        )}
      />
      <TypedConfirm
        open={kind() === "rotateSigning"}
        onClose={close}
        title={t("remote.cloud.rotate.signingTitle")}
        description={t("remote.cloud.rotate.signingBody")}
        expected={t("remote.cloud.word.rotate")}
        confirmLabel={t("remote.cloud.rotate.confirm")}
        danger
        onConfirm={async () => {
          await cloudApi().rotate("signing", "rotate");
          await refreshCloud();
          props.onUpdate();
        }}
      />
      <TypedConfirm
        open={kind() === "rotateVapid"}
        onClose={close}
        title={t("remote.cloud.rotate.vapidTitle")}
        description={t("remote.cloud.rotate.vapidBody")}
        expected={t("remote.cloud.word.rotate")}
        confirmLabel={t("remote.cloud.rotate.confirm")}
        onConfirm={async () => {
          await cloudApi().rotate("vapid", "rotate");
          await refreshCloud();
          props.onUpdate();
        }}
      />
      <TypedConfirm
        open={kind() === "rotateCancelSigning" || kind() === "rotateCancelVapid"}
        onClose={close}
        title={t("remote.cloud.rotate.cancelTitle")}
        description={t("remote.cloud.rotate.cancelBody")}
        expected={t("remote.cloud.word.rotate")}
        confirmLabel={t("remote.cloud.rotate.cancelConfirm")}
        onConfirm={async () => {
          await cloudApi().rotate(kind() === "rotateCancelVapid" ? "vapidCancel" : "signingCancel", "rotate");
          await refreshCloud();
        }}
      />
      <TypedConfirm
        open={kind() === "rollback"}
        onClose={close}
        title={t("remote.cloud.rollback.title")}
        description={t("remote.cloud.rollback.body")}
        expected={prof().workerName}
        confirmLabel={t("remote.cloud.rollback.confirm")}
        onConfirm={async (typed) => {
          const p = await planFor("rollback");
          await runAndToast(() => followRun(() => cloudApi().rollback(typed, p.planId)), "remote.cloud.toast.rolledBack");
        }}
      >
        <PlanCommand />
      </TypedConfirm>
      <TypedConfirm
        open={kind() === "forget"}
        onClose={close}
        title={t("remote.cloud.forget.title")}
        description={t("remote.cloud.forget.body")}
        expected={t("remote.cloud.word.forget")}
        confirmLabel={t("remote.cloud.forget.confirm")}
        danger
        onConfirm={async () => {
          await cloudApi().forget("forget");
          await refreshCloud();
        }}
      />
      <Show when={props.view.removeEnabled}>
        <TypedConfirm
          open={kind() === "remove"}
          onClose={close}
          title={t("remote.cloud.remove.title")}
          description={t("remote.cloud.remove.body")}
          expected={prof().workerName}
          confirmLabel={t("remote.cloud.remove.confirm")}
          danger
          onConfirm={async (typed) => {
            const p = await planFor("remove");
            await runAndToast(() => followRun(() => cloudApi().remove(typed, p.planId)), "remote.cloud.toast.removed");
          }}
        >
          <PlanCommand />
        </TypedConfirm>
      </Show>

      <Dialog
        open={kind() === "token"}
        onClose={close}
        title={t("remote.cloud.token.title")}
        size="sm"
        description={t("remote.cloud.token.body")}
        footer={
          <>
            <Button variant="ghost" onClick={close}>{t("remote.cloud.cancel")}</Button>
            <Button variant="primary" loading={dlgBusy()} disabled={!token().trim()} onClick={() => void simple(async () => { const v = token(); setToken(""); await cloudApi().tokenSet(v); })}>
              {t("remote.cloud.signin.tokenSave")}
            </Button>
          </>
        }
      >
        <Input type="password" size="sm" autocomplete="off" spellcheck={false} value={token()} aria-label={t("remote.cloud.signin.tokenLabel")} data-autofocus onInput={(e) => setToken(e.currentTarget.value)} />
        <ErrorSummary code={dlgCode()} />
      </Dialog>

      <Dialog
        open={kind() === "logout"}
        onClose={close}
        title={t("remote.cloud.logout.title")}
        size="sm"
        role="alertdialog"
        description={t("remote.cloud.logout.body")}
        footer={
          <>
            <Button variant="ghost" onClick={close}>{t("remote.cloud.cancel")}</Button>
            <Button variant="primary" loading={dlgBusy()} onClick={() => void simple(async () => { const h = followRun(() => cloudApi().logout()); await h.started; await h.done; })}>
              {t("remote.cloud.logout.confirm")}
            </Button>
          </>
        }
      >
        <ErrorSummary code={dlgCode()} />
      </Dialog>

      <Dialog
        open={kind() === "stop"}
        onClose={close}
        title={t("remote.cloud.stopUsing.title")}
        size="sm"
        role="alertdialog"
        description={t("remote.cloud.stopUsing.body")}
        footer={
          <>
            <Button variant="ghost" onClick={close}>{t("remote.cloud.cancel")}</Button>
            <Button variant="primary" loading={stopApplier.busy()} onClick={stopApplier.start} data-testid="stop-using-confirm">
              {t("remote.cloud.stopUsing.confirm")}
            </Button>
          </>
        }
      >
        <Show when={isOn()}>
          <Checkbox checked={wipe()} onChange={setWipe} label={t("remote.cloud.stopUsing.wipe")} />
        </Show>
        <ErrorSummary code={stopApplier.code()} />
      </Dialog>
      {stopApplier.dialog()}

      <Dialog open={kind() === "runbook"} onClose={close} title={t("remote.cloud.runbook.title")} size="md" description={t("remote.cloud.runbook.intro")} footer={<Button variant="primary" onClick={close}>{t("remote.cloud.close")}</Button>}>
        <ol class="cloud-list cloud-list--ordered">
          <For each={["panic", "rotate", "worker", "signout", "token"] as const}>{(k) => <li>{t(`remote.cloud.runbook.${k}` as never)}</li>}</For>
        </ol>
      </Dialog>
    </>
  );
}
