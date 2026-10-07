import { createEffect, createSignal, For, on, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { OpOutcome, RebaseStep } from "../../ipc/graph";
import { refreshSnapshots, snapshots } from "../../store/snapshots";
import { repos } from "../../store/workspace";
import { Badge, Button, ChevronDown, ChevronUp, Dialog, EmptyState, GitMerge, GripVertical, Icon, IconButton, Input, Select, Spinner, TextArea, toast, TriangleAlert } from "../../ui-kit";
import { shortOid } from "./format";
import { reloadLog, shownRepoIds } from "./logState";
import { describeOp, errorMessage, needsLiveConfirm, opBlocked } from "./ops";
import { closeRebase, rebaseRequest } from "./rebaseState";
import { moveStep, planChanged, previewRebase, rebaseActions, setAction, setMessage, type RebaseAction } from "./rebase";

/** Interactive rebase: reorder and mark the commits, see the result, run, then continue or abort on a conflict. */
export function RebaseDialog() {
  const [repoId, setRepoId] = createSignal("");
  const [onto, setOnto] = createSignal("origin/main");
  const [original, setOriginal] = createSignal<RebaseStep[]>([]);
  const [steps, setSteps] = createSignal<RebaseStep[]>([]);
  const [outcome, setOutcome] = createSignal<OpOutcome | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [dragging, setDragging] = createSignal<number | null>(null);
  const [liveAsk, setLiveAsk] = createSignal(false);
  const [liveTyped, setLiveTyped] = createSignal("");

  const preview = () => previewRebase(steps());
  const blocked = () => !!outcome() && opBlocked(outcome()!) && outcome()!.kind === "rebase";
  const branch = () => snapshots()[repoId()]?.head.branch ?? "";
  const runnable = () => !busy() && !blocked() && steps().length > 0 && preview().problems.length === 0 && planChanged(original(), steps()) && (!liveAsk() || (branch() !== "" && liveTyped() === branch()));

  const guarded = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      if (needsLiveConfirm(err)) {
        setLiveAsk(true);
        setError(branch() ? t("graph.rebase.liveAsk", { branch: branch() }) : t("graph.rebase.liveAskUnnamed"));
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const loadPlan = () =>
    guarded(async () => {
      const current = await ipc.graph.opState(repoId());
      setOutcome(current);
      if (current.status === "conflict" || current.status === "stopped") return;
      const plan = await ipc.graph.rebasePlan(repoId(), onto());
      setOriginal(plan.steps);
      setSteps(plan.steps);
    });

  // Every time the dialog opens it starts from the request; a request that names a base loads its plan straight away.
  createEffect(
    on(rebaseRequest, (req) => {
      if (!req) return;
      setRepoId(req.repoId ?? shownRepoIds()[0] ?? repos()[0]?.id ?? "");
      if (req.onto) setOnto(req.onto);
      setOriginal([]);
      setSteps([]);
      setOutcome(null);
      setError(null);
      setLiveAsk(false);
      setLiveTyped("");
      if (repoId()) void loadPlan();
    }),
  );

  const settle = async (next: OpOutcome) => {
    setOutcome(next);
    if (opBlocked(next)) return void toast.warn(describeOp(next));
    setOriginal([]);
    setSteps([]);
    toast.success(t("graph.rebase.finished"));
    closeRebase();
    await Promise.all([refreshSnapshots(repoId()), reloadLog()]);
  };

  const run = () => guarded(async () => settle(await ipc.graph.rebaseRun({ repoId: repoId(), onto: onto(), steps: steps() }, liveAsk() ? liveTyped() : undefined)));
  const resume = () => guarded(async () => settle(await ipc.graph.rebaseContinue(repoId())));
  const abort = () =>
    guarded(async () => {
      await ipc.graph.rebaseAbort(repoId());
      setOutcome(null);
      toast.info(t("graph.rebase.aborted"), t("graph.rebase.abortedBody"));
      await loadPlan();
      await Promise.all([refreshSnapshots(repoId()), reloadLog()]);
    });

  const drop = (to: number) => {
    const from = dragging();
    setDragging(null);
    if (from !== null && from !== to) setSteps(moveStep(steps(), from, to));
  };

  return (
    <Dialog
      open={rebaseRequest() !== null}
      onClose={closeRebase}
      title={t("graph.rebase.title")}
      description={t("graph.rebase.desc")}
      size="xl"
      class="grebase"
      closeOnBackdrop={!busy()}
      footer={
        <>
          <Button variant="ghost" onClick={closeRebase} disabled={busy()}>{t("graph.rebase.close")}</Button>
          <Show when={blocked()} fallback={<Button variant="primary" disabled={!runnable()} loading={busy()} onClick={() => void run()}>{t("graph.rebase.run")}</Button>}>
            <Button variant="danger" disabled={busy()} onClick={() => void abort()}>{t("graph.rebase.abortRebase")}</Button>
            <Button variant="primary" loading={busy()} onClick={() => void resume()}>{t("graph.op.continue")}</Button>
          </Show>
        </>
      }
    >
      <div class="grebase__body">
        <div class="grebase__target">
          <label class="grebase__field">
            <span>{t("graph.repository")}</span>
            <Select size="sm" wrapperClass="glog__select" value={repoId()} disabled={busy() || blocked()} onChange={setRepoId} aria-label={t("graph.repository")} options={repos().map((r) => ({ value: r.id, label: r.name }))} />
          </label>
          <label class="grebase__field grebase__field--grow">
            <span>{t("graph.rebase.onto")}</span>
            <Input size="sm" value={onto()} disabled={busy() || blocked()} aria-label={t("graph.rebase.onto")} onInput={(e) => setOnto(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && void loadPlan()} />
          </label>
          <Button size="sm" variant="secondary" disabled={busy() || blocked() || !repoId() || !onto().trim()} onClick={() => void loadPlan()}>{t("graph.rebase.load")}</Button>
        </div>

        <Show when={error()}>
          <p class="grebase__error" role="alert"><Icon icon={TriangleAlert} size={14} /> {error()}</p>
        </Show>
        <Show when={liveAsk() && !blocked()}>
          <label class="grebase__field">
            <span>{t("graph.rebase.typeToRewrite", { branch: branch() })}</span>
            <Input size="sm" aria-label={t("graph.typeConfirm", { branch: branch() })} value={liveTyped()} invalid={liveTyped() !== "" && liveTyped() !== branch()} onInput={(e) => setLiveTyped(e.currentTarget.value)} />
          </label>
        </Show>

        <Show when={blocked() ? outcome() : null}>
          {(op) => (
            <div class="grebase__conflict" role="alert">
              <Badge tone="danger" icon={GitMerge}>{op().status === "conflict" ? t("graph.rebase.conflict") : t("graph.rebase.stopped")}</Badge>
              <p>{t("graph.rebase.resolve", { summary: describeOp(op()) })}</p>
              <Show when={op().conflictFiles.length}>
                <ul><For each={op().conflictFiles}>{(path) => <li class="ui-mono">{path}</li>}</For></ul>
              </Show>
            </div>
          )}
        </Show>

        <Show
          when={steps().length > 0}
          fallback={
            <Show when={busy()} fallback={<Show when={!blocked()}><EmptyState size="sm" icon={GitMerge} title={t("graph.rebase.noCommits")} description={t("graph.rebase.noCommitsDesc")} /></Show>}>
              <div class="grebase__loading"><Spinner /></div>
            </Show>
          }
        >
          <div class="grebase__columns" classList={{ "grebase__columns--locked": blocked() }}>
            <section aria-label={t("graph.rebase.plan")}>
              <h4 class="grebase__title">{t("graph.rebase.planOldest")}</h4>
              <ol class="grebase__steps">
                <For each={steps()}>
                  {(step, i) => (
                    <li
                      class="grebase__step"
                      data-action={step.action}
                      data-dragging={dragging() === i() ? "" : undefined}
                      draggable={!busy() && !blocked()}
                      onDragStart={(e) => (setDragging(i()), e.dataTransfer?.setData("text/plain", step.oid))}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => (e.preventDefault(), drop(i()))}
                      onDragEnd={() => setDragging(null)}
                    >
                      <div class="grebase__line">
                        <span class="grebase__grip" aria-hidden="true"><Icon icon={GripVertical} size={14} /></span>
                        <Select size="sm" wrapperClass="grebase__action" aria-label={t("graph.rebase.actionFor", { subject: step.subject })} value={step.action} disabled={busy() || blocked()} onChange={(action) => setSteps(setAction(steps(), i(), action))} options={rebaseActions()} />
                        <code class="ui-mono grebase__oid">{shortOid(step.oid)}</code>
                        <span class="grebase__subject ui-truncate" title={step.subject}>{step.subject}</span>
                        <IconButton icon={ChevronUp} size="sm" label={t("graph.rebase.moveUp", { subject: step.subject })} disabled={i() === 0 || busy() || blocked()} onClick={() => setSteps(moveStep(steps(), i(), i() - 1))} />
                        <IconButton icon={ChevronDown} size="sm" label={t("graph.rebase.moveDown", { subject: step.subject })} disabled={i() === steps().length - 1 || busy() || blocked()} onClick={() => setSteps(moveStep(steps(), i(), i() + 1))} />
                      </div>
                      <Show when={step.action === "reword"}>
                        <TextArea class="grebase__message" aria-label={t("graph.rebase.newMessage", { subject: step.subject })} minRows={2} maxRows={6} spellcheck={false} value={step.message ?? ""} disabled={busy() || blocked()} onInput={(e) => setSteps(setMessage(steps(), i(), e.currentTarget.value))} />
                      </Show>
                    </li>
                  )}
                </For>
              </ol>
            </section>
            <section aria-label={t("graph.rebase.result")}>
              <h4 class="grebase__title">{t("graph.rebase.result")}</h4>
              <Show when={preview().problems.length}>
                <ul class="grebase__problems" role="alert"><For each={preview().problems}>{(p) => <li>{p}</li>}</For></ul>
              </Show>
              <ol class="grebase__result">
                <For each={preview().commits}>
                  {(c) => (
                    <li>
                      <span class="ui-truncate" title={c.subject}>{c.subject}</span>
                      <Show when={c.reworded}><Badge size="sm" tone="info">{t("graph.rebase.reword")}</Badge></Show>
                      <Show when={c.from.length > 1}><Badge size="sm" tone="accent" numeric>{t("graph.rebase.commitsN", { n: c.from.length })}</Badge></Show>
                    </li>
                  )}
                </For>
              </ol>
              <Show when={!planChanged(original(), steps())}><p class="grebase__hint">{t("graph.rebase.hint")}</p></Show>
            </section>
          </div>
        </Show>
      </div>
    </Dialog>
  );
}
