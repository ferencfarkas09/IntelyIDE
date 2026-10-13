import { createEffect, createSignal, For, on, Show } from "solid-js";
import { t, type MessageKey } from "../../../i18n";
import { ipc } from "../../../ipc";
import type { TransferDirection, TransferPlan } from "../../../ipc/servers";
import { refreshSnapshots } from "../../../store/snapshots";
import { Badge, Button, Checkbox, CircleAlert, Dialog, Icon, Skeleton, StatusLetter, toast } from "../../../ui-kit";
import { messageOf } from "../store";
import { refreshView, type ViewKey } from "./serverView";

export interface TransferTarget extends ViewKey {
  direction: TransferDirection;
  serverName: string;
  repoName: string;
}

const MAX_LISTED = 12;
const riskyLabel = (code: string): string => {
  const key = `serverview.risky.${code}` as MessageKey;
  const text = t(key);
  return text === key ? code : text;
};
const short = (sha?: string | null): string => (sha ?? "").slice(0, 8);

/** The text of an error or a refusal in the person's language; the backend's English message is the fallback for a code we do not know. */
export function transferMessage(code: string | undefined, fallback: string, plan?: Pick<TransferPlan, "localHead" | "serverHead">): string {
  const key = `serverview.err.${code ?? ""}` as MessageKey;
  const text = t(key, { local: short(plan?.localHead), server: short(plan?.serverHead) });
  // (an unknown key comes back as the key itself)
  return text === key ? fallback : text;
}

/** Whether the confirm button may be pressed: a plan without refusal and blocked files, the extra tick given when risky files travel, and the destination clean or "apply on top" ticked. */
export function canConfirm(plan: TransferPlan | undefined, onTop: boolean, riskyTicked = false): boolean {
  if (!plan || plan.refusal || plan.blocked.length > 0 || plan.files.length === 0 || !plan.patchId) return false;
  if (plan.risky.length > 0 && !riskyTicked) return false;
  return plan.destinationClean || onTop;
}

/**
 * The confirmation of a patch transfer. It lists the files and the counts first (nothing has been changed yet) and does the transfer
 * only when the person presses the confirm button. Nothing is committed, staged, pushed, fetched or checked out.
 */
export function TransferDialog(props: { target: TransferTarget | undefined; onClose: () => void }) {
  const [plan, setPlan] = createSignal<TransferPlan | undefined>(undefined);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | undefined>(undefined);
  const [onTop, setOnTop] = createSignal(false);
  const [riskyTicked, setRiskyTicked] = createSignal(false);
  const [working, setWorking] = createSignal(false);
  const bring = () => props.target?.direction === "bring";

  createEffect(
    on(
      () => props.target,
      async (target) => {
        setPlan(undefined);
        setError(undefined);
        setOnTop(false);
        setRiskyTicked(false);
        if (!target) return;
        setLoading(true);
        try {
          const p = await ipc.servers.transferPlan(target.serverId, target.repoId, target.direction);
          if (props.target === target) setPlan(p);
        } catch (e) {
          if (props.target === target) setError(transferMessage((e as { code?: string })?.code, messageOf(e)));
        } finally {
          setLoading(false);
        }
      },
    ),
  );

  const confirm = async () => {
    const target = props.target;
    const p = plan();
    if (!target || !p || !canConfirm(p, onTop(), riskyTicked())) return;
    setWorking(true);
    setError(undefined);
    try {
      const done = await (bring() ? ipc.servers.transferBring : ipc.servers.transferSend)(target.serverId, target.repoId, onTop(), p.patchId, riskyTicked());
      toast.success(t(bring() ? "serverview.dlg.bringDone" : "serverview.dlg.sendDone", { n: done.files }), t("serverview.dlg.doneDesc"));
      props.onClose();
      // the local working tree changed (bring) or the server's did (send)
      if (bring()) void refreshSnapshots(target.repoId);
      void refreshView(target);
    } catch (e) {
      setError(transferMessage((e as { code?: string })?.code, messageOf(e), plan()));
    } finally {
      setWorking(false);
    }
  };

  const refusal = () => {
    const r = plan()?.refusal;
    return r ? transferMessage(r.code, r.message, plan()) : undefined;
  };
  const listed = () => plan()?.files.slice(0, MAX_LISTED) ?? [];

  return (
    <Dialog
      open={!!props.target}
      onClose={() => !working() && props.onClose()}
      size="md"
      role="alertdialog"
      title={t(bring() ? "serverview.dlg.bringTitle" : "serverview.dlg.sendTitle", { server: props.target?.serverName ?? "" })}
      description={t(bring() ? "serverview.dlg.bringIntro" : "serverview.dlg.sendIntro", { server: props.target?.serverName ?? "", repo: props.target?.repoName ?? "" })}
      footer={
        <>
          <Button variant="ghost" disabled={working()} onClick={() => props.onClose()}>
            {t("serverview.dlg.cancel")}
          </Button>
          <Button variant="primary" loading={working()} disabled={!canConfirm(plan(), onTop(), riskyTicked())} onClick={() => void confirm()} data-autofocus>
            {t(bring() ? "serverview.dlg.confirmBring" : "serverview.dlg.confirmSend")}
          </Button>
        </>
      }
    >
      <div class="sv-dlg">
        <Show when={!loading()} fallback={<div class="sv-dlg__loading" aria-busy="true" aria-label={t("serverview.dlg.loading")}><Skeleton height={14} width="60%" /><Skeleton height={14} width="40%" /><Skeleton height={14} width="52%" /></div>}>
          <Show when={error()}>
            <p class="sv-dlg__problem" role="alert">
              <Icon icon={CircleAlert} size={14} /> {error()}
            </p>
          </Show>
          <Show when={refusal()}>
            <p class="sv-dlg__problem" role="alert">
              <Icon icon={CircleAlert} size={14} /> {refusal()}
            </p>
          </Show>
          <Show when={plan()}>
            {(p) => (
              <>
                <Show when={!p().refusal}>
                  <p class="sv-dlg__counts">
                    <Badge tone="info" size="sm" numeric>{t("serverview.dlg.counts", { tracked: p().tracked, untracked: p().untracked })}</Badge>
                    <span class="sv-dlg__sha">{t("serverview.dlg.sameCommit", { sha: short(p().localHead) })}</span>
                  </p>
                  <Show when={p().blocked.length > 0}>
                    <div class="sv-dlg__blocked" role="alert">
                      <p>{t("serverview.dlg.blocked")}</p>
                      <ul>
                        <For each={p().blocked.slice(0, MAX_LISTED)}>
                          {(b) => (
                            <li>
                              <Show when={b.path}>
                                <code>{b.path}</code>{" "}
                              </Show>
                              {t(`serverview.blocked.${b.code}` as MessageKey) === `serverview.blocked.${b.code}` ? b.reason : t(`serverview.blocked.${b.code}` as MessageKey)}
                            </li>
                          )}
                        </For>
                      </ul>
                    </div>
                  </Show>
                  <Show when={p().risky.length > 0}>
                    <div class="sv-dlg__risky" role="alert">
                      <p>{t("serverview.dlg.risky")}</p>
                      <ul>
                        <For each={p().risky.slice(0, MAX_LISTED)}>
                          {(r) => (
                            <li>
                              <code>{r.path}</code> <Badge tone="warn" size="sm">{riskyLabel(r.code)}</Badge>
                            </li>
                          )}
                        </For>
                      </ul>
                      <Checkbox checked={riskyTicked()} onChange={(v) => setRiskyTicked(v)} label={t("serverview.dlg.riskyTick")} />
                    </div>
                  </Show>
                  <h3 class="sv-dlg__h">{t("serverview.dlg.stat")} <span class="sv-dlg__bytes ui-tnum">{t("serverview.dlg.bytes", { kb: Math.max(1, Math.round(p().bytes / 1024)) })}</span></h3>
                  <ul class="sv-dlg__files" aria-label={t("serverview.dlg.files")}>
                    <For each={listed()}>
                      {(f) => {
                        const stat = () => p().stat.find((s) => s.path === f.path);
                        const risky = () => p().risky.some((r) => r.path === f.path);
                        return (
                          <li classList={{ "sv-dlg__row--risky": risky() }}>
                            <StatusLetter kind={f.kind} />
                            <span class="sv-dlg__path ui-truncate" title={f.path}>{f.path}</span>
                            <Show when={f.untracked}>
                              <Badge size="sm">{t("serverview.kind.new")}</Badge>
                            </Show>
                            <Show when={stat()}>
                              {(s) => (
                                <span class="sv-dlg__stat ui-tnum">{s().binary ? t("serverview.dlg.binary") : t("serverview.dlg.statLine", { added: s().added ?? 0, deleted: s().deleted ?? 0 })}</span>
                              )}
                            </Show>
                          </li>
                        );
                      }}
                    </For>
                    <Show when={p().files.length > MAX_LISTED}>
                      <li class="sv-dlg__more">{t("serverview.dlg.more", { n: p().files.length - MAX_LISTED })}</li>
                    </Show>
                  </ul>
                  <p class="sv-dlg__help">{t("serverview.dlg.noteContents")}</p>
                  <Show when={!bring()}>
                    <p class="sv-dlg__help">{t("serverview.dlg.noteSend")}</p>
                  </Show>
                  <Show when={!p().destinationClean}>
                    <div class="sv-dlg__top">
                      <Checkbox checked={onTop()} onChange={(v) => setOnTop(v)} label={t("serverview.dlg.onTop")} />
                      <p class="sv-dlg__help">{t(bring() ? (onTop() ? "serverview.dlg.onTopBring" : "serverview.dlg.dirtyBring") : onTop() ? "serverview.dlg.onTopSend" : "serverview.dlg.dirtySend")}</p>
                    </div>
                  </Show>
                </Show>
              </>
            )}
          </Show>
        </Show>
      </div>
    </Dialog>
  );
}
