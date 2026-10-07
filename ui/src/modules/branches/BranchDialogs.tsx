import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { SwitchResult } from "../../ipc/branches";
import { repoConfig, repos, workspace } from "../../store/workspace";
import { Badge, Button, CircleAlert, CircleCheck, Dialog, Icon, Info, Input, Minus, Pill, RepoBadge, Switch, TriangleAlert } from "../../ui-kit";
import { createBranch, deleteBranch, rollbackFiles, stashAction, switchAllRepos, untrackedIn } from "./actions";
import { branchNameError, isLive, livePatterns, rollbackCount } from "./logic";
import { rich } from "./rich";
import { closeDialog, dialog, openDialog, type BranchDialog } from "./uiState";
import "./branches.css";

type Of<K extends BranchDialog["kind"]> = Extract<BranchDialog, { kind: K }>;
const repoLabel = (id: string) => repoConfig(id)?.name ?? id;

function RepoLine(props: { repoId: string }) {
  return (
    <>
      <Show when={repoConfig(props.repoId)}>{(r) => <RepoBadge color={r().color} badge={r().badge} size={16} />}</Show>
      <span class="bpd__repo ui-truncate">{repoLabel(props.repoId)}</span>
    </>
  );
}

function NewBranchDialog(props: { d: Of<"newBranch"> }) {
  const [repoId, setRepoId] = createSignal(props.d.repoId);
  const [name, setName] = createSignal("");
  const [from, setFrom] = createSignal(props.d.from ?? "");
  const [checkout, setCheckout] = createSignal(true);
  const [busy, setBusy] = createSignal(false);
  const [list] = createResource(repoId, (id) => ipc.branches.list(id));
  const error = () => branchNameError(name(), list()?.local ?? []);
  const valid = () => name().length > 0 && !error() && !list.loading;
  const submit = async () => {
    if (!valid() || busy()) return;
    setBusy(true);
    const ok = await createBranch(repoId(), name(), from().trim() || undefined, checkout());
    setBusy(false);
    if (ok) closeDialog();
  };
  return (
    <Dialog
      open={dialog() === props.d}
      onClose={closeDialog}
      size="sm"
      title={t("branches.newTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={closeDialog}>
            {t("branches.cancel")}
          </Button>
          <Button variant="primary" disabled={!valid()} loading={busy()} onClick={() => void submit()}>
            {t("branches.create")}
          </Button>
        </>
      }
    >
      <form class="bpd__form" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <Show when={repos().length > 1}>
          <div class="bpd__chips" role="group" aria-label={t("branches.repository")}>
            <For each={repos()}>
              {(r) => (
                <Pill size="sm" selected={repoId() === r.id} onClick={() => setRepoId(r.id)} aria-label={r.name} buttonProps={{ "aria-pressed": repoId() === r.id }} leading={<RepoBadge color={r.color} badge={r.badge} size={16} />}>
                  {r.name}
                </Pill>
              )}
            </For>
          </div>
        </Show>
        <label class="bpd__field">
          <span>{t("branches.name")}</span>
          <Input data-autofocus placeholder="feature/short-name" autocomplete="off" spellcheck={false} invalid={!!error()} value={name()} onInput={(e) => setName(e.currentTarget.value)} />
          <Show when={error()}>
            <span class="bpd__error">{error()}</span>
          </Show>
        </label>
        <label class="bpd__field">
          <span>{t("branches.startFrom")}</span>
          <Input list="bpd-from" placeholder={list()?.current ?? t("branches.currentBranchPh")} autocomplete="off" spellcheck={false} value={from()} onInput={(e) => setFrom(e.currentTarget.value)} />
          <datalist id="bpd-from">
            <For each={[...(list()?.local ?? []), ...(list()?.remote ?? [])]}>{(b) => <option value={b} />}</For>
          </datalist>
        </label>
        <Switch checked={checkout()} onChange={setCheckout} label={t("branches.checkoutNew")} />
      </form>
    </Dialog>
  );
}

function DeleteDialog(props: { d: Of<"delete"> }) {
  const [typed, setTyped] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const confirmed = () => !props.d.live || typed() === props.d.name;
  const run = async () => {
    if (!confirmed() || busy()) return;
    setBusy(true);
    const result = await deleteBranch(props.d.repoId, props.d.name, props.d.needsForce);
    setBusy(false);
    if (result === "notMerged") return openDialog({ ...props.d, needsForce: true });
    closeDialog();
  };
  return (
    <Dialog
      open={dialog() === props.d}
      onClose={closeDialog}
      role="alertdialog"
      size="sm"
      title={props.d.needsForce ? t("branches.deleteForceTitle", { name: props.d.name }) : t("branches.deleteTitle", { name: props.d.name })}
      footer={
        <>
          <Button variant="ghost" onClick={closeDialog}>
            {t("branches.cancel")}
          </Button>
          <Button variant="danger" disabled={!confirmed()} loading={busy()} onClick={() => void run()}>
            {props.d.needsForce ? t("branches.forceDelete") : t("branches.delete")}
          </Button>
        </>
      }
    >
      <div class="bpd__stack">
        <p class="bpd__text">
          {rich("branches.deleteText", { name: () => <code class="ui-mono">{props.d.name}</code>, repo: () => <strong>{repoLabel(props.d.repoId)}</strong> })}
        </p>
        <Show when={props.d.needsForce}>
          <p class="bpd__note" data-tone="warn">
            <Icon icon={TriangleAlert} size={14} /> {t("branches.notMerged")}
          </p>
        </Show>
        <Show when={props.d.live}>
          <label class="bpd__field">
            <span>
              {rich("branches.liveConfirm", { name: () => <code class="ui-mono">{props.d.name}</code> })}
            </span>
            <Input data-autofocus aria-label={t("branches.typeToDelete", { name: props.d.name })} autocomplete="off" spellcheck={false} value={typed()} onInput={(e) => setTyped(e.currentTarget.value)} />
          </label>
        </Show>
      </div>
    </Dialog>
  );
}

/** "skipped" covers two cases the engine tells apart by its reason; a dirty tree names itself instead of a bare "Failed". */
const resultLabel = (r: SwitchResult): string =>
  r.status === "switched"
    ? t("branches.result.switched")
    : r.status === "skipped"
      ? r.error === "already on it" ? t("branches.result.already") : t("branches.result.noBranch")
      : r.code === "dirtyTree" ? t("branches.result.dirty") : t("branches.result.failed");

function SwitchAllDialog(props: { d: Of<"switchAll"> }) {
  const [name, setName] = createSignal(props.d.name ?? "");
  const [results, setResults] = createSignal<SwitchResult[] | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [known] = createResource(async () => {
    const counts = new Map<string, number>();
    for (const r of repos()) for (const b of (await ipc.branches.list(r.id)).local) counts.set(b, (counts.get(b) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
  });
  const liveName = () => repos().some((r) => isLive(name(), livePatterns(workspace(), r.id)));
  const run = async () => {
    if (!name().trim() || busy()) return;
    setBusy(true);
    setResults(await switchAllRepos(name().trim()).catch((e) => repos().map((r): SwitchResult => ({ repoId: r.id, status: "failed", error: String(e?.message ?? e) }))));
    setBusy(false);
  };
  const tally = () => {
    const all = results() ?? [];
    const n = (s: SwitchResult["status"]) => all.filter((r) => r.status === s).length;
    const counts = { switched: n("switched"), skipped: n("skipped"), failed: n("failed") };
    return counts.failed ? t("branches.tallyFailed", counts) : t("branches.tally", counts);
  };
  return (
    <Dialog
      open={dialog() === props.d}
      onClose={closeDialog}
      size="sm"
      title={results() ? t("branches.switchedTitle", { name: name() }) : t("branches.switchAllTitle")}
      description={results() ? tally() : t("branches.switchAllDesc")}
      footer={
        <Show
          when={results()}
          fallback={
            <>
              <Button variant="ghost" onClick={closeDialog}>
                {t("branches.cancel")}
              </Button>
              <Button variant="primary" disabled={!name().trim()} loading={busy()} onClick={() => void run()}>
                {t("branches.switchAllBtn")}
              </Button>
            </>
          }
        >
          <Button variant="primary" onClick={closeDialog}>
            {t("branches.done")}
          </Button>
        </Show>
      }
    >
      <Show
        when={results()}
        fallback={
          <form class="bpd__stack" onSubmit={(e) => (e.preventDefault(), void run())}>
            <Input data-autofocus aria-label={t("branches.branchName")} placeholder={t("branches.branchName")} autocomplete="off" spellcheck={false} value={name()} onInput={(e) => setName(e.currentTarget.value)} />
            <Show when={known()?.length}>
              <div class="bpd__chips" role="group" aria-label={t("branches.inWorkspace")}>
                <For each={known()}>
                  {([b, count]) => (
                    <Pill size="sm" selected={name() === b} onClick={() => setName(b)} buttonProps={{ "aria-pressed": name() === b }} trailing={<span class="ui-tnum">{count}/{repos().length}</span>}>
                      {b}
                    </Pill>
                  )}
                </For>
              </div>
            </Show>
            <Show when={liveName()}>
              <p class="bpd__note" data-tone="info">
                <Icon icon={Info} size={14} /> {t("branches.liveNote")}
              </p>
            </Show>
          </form>
        }
      >
        {(all) => (
          <ul class="bpd__results" aria-label={t("branches.resultPerRepo")}>
            <For each={all()}>
              {(r) => (
                <li class="bpd__result" data-status={r.status}>
                  <RepoLine repoId={r.repoId} />
                  <span class="bpd__status">
                    <Icon icon={r.status === "switched" ? CircleCheck : r.status === "failed" ? CircleAlert : Minus} size={14} />
                    {resultLabel(r)}
                  </span>
                  <Show when={r.error}>
                    <span class="bpd__why">{r.error}</span>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        )}
      </Show>
    </Dialog>
  );
}

function RollbackDialog(props: { d: Of<"rollback"> }) {
  const [busy, setBusy] = createSignal(false);
  const count = () => rollbackCount(props.d.targets);
  const untracked = () => props.d.targets.reduce((n, x) => n + untrackedIn(x.repoId, x.paths), 0);
  const run = async () => {
    setBusy(true);
    await rollbackFiles(props.d.targets);
    setBusy(false);
    closeDialog();
  };
  return (
    <Dialog
      open={dialog() === props.d}
      onClose={closeDialog}
      role="alertdialog"
      size="sm"
      title={t("branches.rollbackTitle", { count: count() })}
      footer={
        <>
          <Button variant="ghost" onClick={closeDialog}>
            {t("branches.cancel")}
          </Button>
          <Button variant="danger" data-autofocus loading={busy()} onClick={() => void run()}>
            {t("branches.rollbackBtn")}
          </Button>
        </>
      }
    >
      <div class="bpd__stack">
        <p class="bpd__note" data-tone="info">
          <Icon icon={Info} size={14} /> {t("branches.rollbackBackup")}
        </p>
        <For each={props.d.targets}>
          {(g) => (
            <div class="bpd__group">
              <div class="bpd__group-head">
                <RepoLine repoId={g.repoId} />
                <Badge size="sm" numeric>
                  {g.paths.length}
                </Badge>
              </div>
              <ul class="bpd__files ui-mono">
                <For each={g.paths.slice(0, 6)}>{(p) => <li class="ui-truncate" title={p}>{p}</li>}</For>
                <Show when={g.paths.length > 6}>
                  <li class="bpd__more">{t("branches.andMore", { count: g.paths.length - 6 })}</li>
                </Show>
              </ul>
            </div>
          )}
        </For>
        <Show when={untracked() > 0}>
          <p class="bpd__note" data-tone="warn">
            <Icon icon={TriangleAlert} size={14} /> {t("branches.untrackedNote", { count: untracked() })}
          </p>
        </Show>
      </div>
    </Dialog>
  );
}

function StashDropDialog(props: { d: Of<"stashDrop"> }) {
  const [busy, setBusy] = createSignal(false);
  const run = async () => {
    setBusy(true);
    await stashAction("drop", props.d.repoId, props.d.index);
    setBusy(false);
    closeDialog();
  };
  return (
    <Dialog
      open={dialog() === props.d}
      onClose={closeDialog}
      role="alertdialog"
      size="sm"
      title={t("branches.dropTitle")}
      footer={
        <>
          <Button variant="ghost" onClick={closeDialog}>
            {t("branches.cancel")}
          </Button>
          <Button variant="danger" data-autofocus loading={busy()} onClick={() => void run()}>
            {t("branches.drop")}
          </Button>
        </>
      }
    >
      <p class="bpd__text">
        {rich("branches.dropText", { message: () => <strong>{props.d.message}</strong>, repo: () => repoLabel(props.d.repoId) })}
      </p>
    </Dialog>
  );
}

/** Mounted by the shell the first time a dialog is requested. Each dialog is created per request, so its form starts fresh. */
export default function BranchDialogs() {
  const held = createMemo<BranchDialog | null>((prev) => dialog() ?? prev, null);
  const as = <K extends BranchDialog["kind"]>(kind: K): Of<K> | undefined => {
    const d = held();
    return d?.kind === kind ? (d as Of<K>) : undefined;
  };
  return (
    <>
      <Show when={as("newBranch")} keyed>{(d) => <NewBranchDialog d={d} />}</Show>
      <Show when={as("delete")} keyed>{(d) => <DeleteDialog d={d} />}</Show>
      <Show when={as("switchAll")} keyed>{(d) => <SwitchAllDialog d={d} />}</Show>
      <Show when={as("rollback")} keyed>{(d) => <RollbackDialog d={d} />}</Show>
      <Show when={as("stashDrop")} keyed>{(d) => <StashDropDialog d={d} />}</Show>
    </>
  );
}
