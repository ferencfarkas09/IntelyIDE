import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { cancelRun, closePushDialog, pushDialogRequest, repoName } from "../../store/actions";
import { workspace } from "../../store/workspace";
import type { OutgoingInfo, TagsMode } from "../../ipc";
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Icon,
  IconButton,
  Input,
  Lock,
  Pencil,
  Pill,
  Popover,
  ProgressBar,
  RefreshCw,
  RepoBadge,
  ScrollArea,
  SegmentedControl,
  Skeleton,
  Spinner,
  SplitButton,
  StatusLetter,
  Switch,
  Tree,
  TreeRow,
  TriangleAlert,
  Upload,
  ArrowRight,
  GitBranch,
  GitCommitHorizontal,
  FileText,
  CircleAlert,
} from "../../ui-kit";
import { STATUS_LABEL } from "../results/logic";
import { t } from "../../i18n";
import { tRich } from "../richText";
import { isPushable, outgoingLabel, splitPath, timeAgo } from "./logic";
import { createPushModel, type PushModel, type TargetEdit } from "./model";
import "./push.css";
import { previewNonProtected, pushTags, runGitHooks, setPreviewNonProtected, setPushTags, setRunGitHooks } from "./settings";

const repoOf = (id: string) => workspace()?.repos.find((r) => r.id === id);

/** `local -> remote/branch`, with a lock for protected targets and the accent when it differs from the local name. */
function TargetPill(props: { plan: OutgoingInfo }) {
  const remapped = () => props.plan.remoteBranch !== props.plan.local;
  return (
    <Pill
      size="sm"
      tone={remapped() ? "accent" : "neutral"}
      class="push-target"
      title={t(props.plan.protected ? "push.targetTitleProtected" : "push.targetTitle", { local: props.plan.local, target: `${props.plan.remote}/${props.plan.remoteBranch}` })}
      leading={<Icon icon={GitBranch} size={12} />}
    >
      <span class="ui-mono">{props.plan.local}</span>
      <Icon icon={ArrowRight} size={12} class="push-target__arrow" />
      <span class="ui-mono">
        {props.plan.remote}/{props.plan.remoteBranch}
      </span>
      <Show when={props.plan.protected}>
        <Icon icon={Lock} size={12} class="push-target__lock" label={t("push.protectedBranch")} />
      </Show>
    </Pill>
  );
}

/** Remote and branch fields of one repo; used by the per-row popover. */
function TargetForm(props: { plan: OutgoingInfo; model: PushModel; onDone: () => void }) {
  const [remote, setRemote] = createSignal(props.plan.remote);
  const [branch, setBranch] = createSignal(props.plan.remoteBranch);
  const valid = () => remote().trim() !== "" && branch().trim() !== "";
  const save = async () => {
    if (!valid()) return;
    if (await props.model.saveTargets([{ repoId: props.plan.repoId, remote: remote(), branch: branch() }])) props.onDone();
  };
  return (
    <form
      class="push-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div class="push-form__title">{t("push.targetFor", { name: repoName(props.plan.repoId) })}</div>
      <label class="push-form__field">
        <span>{t("push.remote")}</span>
        <Input size="sm" value={remote()} onInput={(e) => setRemote(e.currentTarget.value)} data-autofocus spellcheck={false} />
      </label>
      <label class="push-form__field">
        <span>{t("push.branch")}</span>
        <Input size="sm" value={branch()} onInput={(e) => setBranch(e.currentTarget.value)} spellcheck={false} />
      </label>
      <div class="push-form__actions">
        <Button size="sm" variant="ghost" onClick={props.onDone}>
          {t("comp.cancel")}
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!valid()}>
          {t("comp.save")}
        </Button>
      </div>
    </form>
  );
}

function EditAllTargets(props: { open: boolean; model: PushModel; onClose: () => void }) {
  const [edits, setEdits] = createStore<Record<string, { remote: string; branch: string }>>({});
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) setEdits(Object.fromEntries(props.model.state.plans.map((p) => [p.repoId, { remote: p.remote, branch: p.remoteBranch }])));
      },
    ),
  );
  const list = (): TargetEdit[] => props.model.state.plans.map((p) => ({ repoId: p.repoId, remote: edits[p.repoId]?.remote ?? p.remote, branch: edits[p.repoId]?.branch ?? p.remoteBranch }));
  const valid = () => list().every((e) => e.remote.trim() !== "" && e.branch.trim() !== "");
  const save = async () => {
    if (valid() && (await props.model.saveTargets(list()))) props.onClose();
  };
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      size="lg"
      title={t("push.editAllTitle")}
      description={t("push.editAllDesc")}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            {t("comp.cancel")}
          </Button>
          <Button variant="primary" disabled={!valid()} onClick={() => void save()}>
            {t("push.saveTargets")}
          </Button>
        </>
      }
    >
      <div
        class="push-targets"
        role="table"
        aria-label={t("push.targetsTable")}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.target instanceof HTMLInputElement) {
            e.preventDefault();
            void save();
          }
        }}
      >
        <div class="push-targets__head" role="row">
          <span role="columnheader">{t("push.colRepo")}</span>
          <span role="columnheader">{t("push.colLocal")}</span>
          <span role="columnheader">{t("push.remote")}</span>
          <span role="columnheader">{t("push.colRemoteBranch")}</span>
        </div>
        <For each={props.model.state.plans}>
          {(plan) => (
            <div class="push-targets__row" role="row">
              <span class="push-targets__repo" role="cell">
                <Show when={repoOf(plan.repoId)}>{(r) => <RepoBadge color={r().color} badge={r().badge} size={16} />}</Show>
                <span class="ui-truncate">{repoName(plan.repoId)}</span>
              </span>
              <span class="ui-mono ui-truncate push-targets__local" role="cell">
                {plan.local}
              </span>
              <span role="cell">
                <Input size="sm" aria-label={t("push.remoteFor", { name: repoName(plan.repoId) })} value={edits[plan.repoId]?.remote ?? ""} onInput={(e) => setEdits(plan.repoId, "remote", e.currentTarget.value)} spellcheck={false} />
              </span>
              <span role="cell">
                <Input size="sm" aria-label={t("push.remoteBranchFor", { name: repoName(plan.repoId) })} value={edits[plan.repoId]?.branch ?? ""} onInput={(e) => setEdits(plan.repoId, "branch", e.currentTarget.value)} spellcheck={false} />
              </span>
            </div>
          )}
        </For>
      </div>
      <Show when={props.model.state.notice}>
        <p class="push-notice" role="alert">
          {props.model.state.notice}
        </p>
      </Show>
    </Dialog>
  );
}

function ForceDialog(props: { open: boolean; model: PushModel; onClose: () => void; onConfirm: () => void }) {
  const [typed, setTyped] = createStore<Record<string, string>>({});
  createEffect(on(() => props.open, (open) => open && setTyped(reconcile({}))));
  const rows = createMemo(() => (props.open ? props.model.forceRows() : []));
  const allowed = () => props.model.canConfirmForce(rows(), typed);
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      role="alertdialog"
      size="md"
      title={t("push.forceTitle")}
      description={t("push.forceDesc")}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            {t("comp.cancel")}
          </Button>
          <Button variant="danger" icon={TriangleAlert} disabled={!allowed()} onClick={props.onConfirm}>
            {t("push.forceBtn")}
          </Button>
        </>
      }
    >
      <ul class="push-force">
        <For each={rows()}>
          {(row, i) => (
            <li class="push-force__row" data-protected={row.protected ? "" : undefined}>
              <div class="push-force__head">
                <span class="push-force__repo">{row.repoName}</span>
                <span class="ui-mono push-force__target">{row.target}</span>
                <Show when={row.protected}>
                  <Badge tone="warn" icon={Lock} size="sm">
                    {t("push.protected")}
                  </Badge>
                </Show>
              </div>
              <p class="push-force__impact">
                {row.overwritten === null ? t("push.impact.unknown") : row.overwritten === 0 ? t("push.impact.none") : t("push.impact.some", { n: row.overwritten })}
              </p>
              <Show when={row.protected}>
                <label class="push-force__confirm">
                  <span>{tRich("push.typeConfirm", { branch: <strong class="ui-mono">{row.branch}</strong> })}</span>
                  <Input
                    size="sm"
                    data-autofocus={i() === 0 || undefined}
                    value={typed[row.repoId] ?? ""}
                    onInput={(e) => setTyped(row.repoId, e.currentTarget.value)}
                    invalid={!!typed[row.repoId] && typed[row.repoId] !== row.branch}
                    spellcheck={false}
                    autocomplete="off"
                    aria-label={t("push.typeConfirmAria", { branch: row.branch, repo: row.repoName })}
                  />
                </label>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Dialog>
  );
}

function RepoProgress(props: { model: PushModel; repoId: string }) {
  const p = () => props.model.progress(props.repoId);
  return (
    <Show when={p()}>
      {(state) => (
        <span class="push-progress" data-status={state().status}>
          <Show when={!["done", "failed", "cancelled", "skipped"].includes(state().status)} fallback={<span>{STATUS_LABEL[state().status]}</span>}>
            <Spinner size={12} />
            <span>{STATUS_LABEL[state().status]}</span>
            <Show when={state().percent != null}>
              <ProgressBar value={state().percent!} size="sm" aria-label={t("results.pushProgress", { name: repoName(props.repoId) })} class="push-progress__bar" />
            </Show>
          </Show>
        </span>
      )}
    </Show>
  );
}

function CommitsTree(props: { model: PushModel }) {
  const { state } = props.model;
  const [cursor, setCursor] = createSignal<string | null>(null);
  let tree: HTMLDivElement | undefined;

  const keys = createMemo(() =>
    state.plans.flatMap((p) => [`repo:${p.repoId}`, ...(state.expanded[p.repoId] ? p.commits.map((c) => `commit:${p.repoId}:${c.oid}`) : [])]),
  );
  const active = () => cursor() ?? keys()[0];
  // The tree appears when the plan has loaded; the dialog's own initial focus had nothing useful to land on yet.
  onMount(() => {
    const dialog = tree?.closest(".push-dialog");
    if (dialog?.contains(document.activeElement) && document.activeElement !== tree) queueMicrotask(() => tree?.querySelector<HTMLElement>('[tabindex="0"]')?.focus());
  });
  const focusKey = (key: string) => {
    setCursor(key);
    queueMicrotask(() => tree?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus());
  };
  const parseKey = (key: string) => {
    const [kind, repoId, oid] = key.split(":");
    return { kind, repoId, oid };
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const key = active();
    if (!key || (e.target as HTMLElement).closest("input,button:not([role])")) return;
    const list = keys();
    const i = list.indexOf(key);
    const { kind, repoId, oid } = parseKey(key);
    const plan = state.plans.find((p) => p.repoId === repoId);
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); return focusKey(list[Math.min(i + 1, list.length - 1)]);
      case "ArrowUp": e.preventDefault(); return focusKey(list[Math.max(i - 1, 0)]);
      case "Home": e.preventDefault(); return focusKey(list[0]);
      case "End": e.preventDefault(); return focusKey(list[list.length - 1]);
      case "ArrowRight":
        e.preventDefault();
        if (kind === "repo" && plan?.commits.length) return state.expanded[repoId] ? focusKey(list[i + 1]) : props.model.toggleExpanded(repoId);
        return;
      case "ArrowLeft":
        e.preventDefault();
        if (kind === "commit") return focusKey(`repo:${repoId}`);
        if (state.expanded[repoId]) props.model.toggleExpanded(repoId);
        return;
      case " ":
        if (kind === "repo") {
          e.preventDefault();
          props.model.toggleRepo(repoId, !state.checks[repoId]);
        }
        return;
      case "Enter":
        if (kind === "commit") {
          e.preventDefault();
          props.model.selectCommit(repoId, oid);
        } else if (plan?.commits.length) props.model.toggleExpanded(repoId);
    }
  };

  return (
    <Tree ref={(el) => (tree = el)} aria-label={t("push.tree")} class="push-tree" onKeyDown={onKeyDown}>
      <For each={state.plans}>
        {(plan) => {
          const repo = () => repoOf(plan.repoId);
          const key = `repo:${plan.repoId}`;
          const pushable = () => isPushable(plan);
          return (
            <>
              <TreeRow
                data-key={key}
                depth={0}
                expanded={plan.commits.length ? !!state.expanded[plan.repoId] : undefined}
                onToggle={() => props.model.toggleExpanded(plan.repoId)}
                disabled={!pushable()}
                cursor={active() === key}
                tabbable={active() === key}
                onFocus={() => setCursor(key)}
                leading={
                  <>
                    <Checkbox
                      size="sm"
                      tabIndex={-1}
                      checked={!!state.checks[plan.repoId]}
                      disabled={!pushable() || props.model.running()}
                      aria-label={t("changes.pushRepo", { name: repoName(plan.repoId) })}
                      onChange={(on) => props.model.toggleRepo(plan.repoId, on)}
                    />
                    <Show when={repo()}>{(r) => <RepoBadge color={r().color} badge={r().badge} size={16} />}</Show>
                  </>
                }
                trailing={
                  <Show
                    when={props.model.running() && props.model.progress(plan.repoId)}
                    fallback={
                      <span class="push-count ui-tnum" data-empty={pushable() ? undefined : ""}>
                        {outgoingLabel(plan)}
                      </span>
                    }
                  >
                    <RepoProgress model={props.model} repoId={plan.repoId} />
                  </Show>
                }
                actions={
                  props.model.running() ? undefined : (
                  <Popover
                    aria-label={t("push.editTargetOf", { name: repoName(plan.repoId) })}
                    placement="bottom-end"
                    trigger={(tr) => <IconButton {...tr} icon={Pencil} size="sm" label={t("push.editTarget")} />}
                  >
                    {(api) => <TargetForm plan={plan} model={props.model} onDone={api.close} />}
                  </Popover>
                  )
                }
              >
                <span class="push-repo">
                  <span class="push-repo__name">{repoName(plan.repoId)}</span>
                  <TargetPill plan={plan} />
                </span>
              </TreeRow>
              <Show when={state.expanded[plan.repoId]}>
                <For each={plan.commits}>
                  {(commit) => {
                    const ckey = `commit:${plan.repoId}:${commit.oid}`;
                    return (
                      <TreeRow
                        data-key={ckey}
                        depth={1}
                        compact
                        selected={state.selected?.oid === commit.oid && state.selected.repoId === plan.repoId}
                        cursor={active() === ckey}
                        tabbable={active() === ckey}
                        onFocus={() => setCursor(ckey)}
                        onClick={() => props.model.selectCommit(plan.repoId, commit.oid)}
                        leading={<Icon icon={GitCommitHorizontal} size={14} class="push-commit__icon" />}
                        trailing={
                          <span class="push-commit__meta">
                            {commit.author} · {timeAgo(commit.dateMs)}
                          </span>
                        }
                      >
                        <span class="push-commit__oid ui-mono">{commit.shortOid}</span>
                        <span class="push-commit__subject">{commit.subject}</span>
                      </TreeRow>
                    );
                  }}
                </For>
              </Show>
            </>
          );
        }}
      </For>
    </Tree>
  );
}

function FilesPane(props: { model: PushModel }) {
  const { state } = props.model;
  const selected = () => state.selected;
  const commit = createMemo(() => {
    const s = selected();
    return s ? state.plans.find((p) => p.repoId === s.repoId)?.commits.find((c) => c.oid === s.oid) : undefined;
  });
  const files = () => (selected() ? state.files[`${selected()!.repoId}:${selected()!.oid}`] : undefined);
  const ready = () => {
    const f = files();
    return f?.status === "ready" ? f.files : undefined;
  };
  return (
    <section class="push-files" aria-label={t("push.changedFiles")}>
      <Show when={commit()} fallback={
        <Show when={state.plans.some((p) => p.commits.length > 0)} fallback={<EmptyState size="sm" icon={FileText} title={t("push.nothing")} description={t("push.nothingDesc")} />}>
          <EmptyState size="sm" icon={FileText} title={t("push.noCommit")} description={t("push.noCommitDesc")} />
        </Show>
      }>
        {(c) => (
          <>
            <header class="push-files__head">
              <span class="push-files__subject ui-truncate">{c().subject}</span>
              <span class="push-files__oid ui-mono">{c().shortOid}</span>
            </header>
            <ScrollArea class="push-files__scroll">
              <Show when={ready()} fallback={
                <Show when={files()?.status === "error"} fallback={
                  <div class="push-files__loading" aria-busy="true">
                    <Skeleton height={14} width="70%" /> <Skeleton height={14} width="55%" /> <Skeleton height={14} width="64%" />
                  </div>
                }>
                  <EmptyState size="sm" tone="danger" icon={CircleAlert} title={t("push.filesFailed")} />
                </Show>
              }>
                <ul class="push-files__list">
                  <For each={ready()}>
                    {(file) => {
                      const { dir, name } = splitPath(file.path);
                      return (
                        <li class="push-files__item">
                          <StatusLetter kind={file.kind} />
                          <span class="push-files__name ui-truncate" classList={{ "ui-file-deleted": file.kind === "deleted" }}>
                            {name}
                            <Show when={dir}>
                              <span class="ui-path-hint">{dir}</span>
                            </Show>
                          </span>
                        </li>
                      );
                    }}
                  </For>
                </ul>
              </Show>
            </ScrollArea>
          </>
        )}
      </Show>
    </section>
  );
}

const tagOptions = (): { value: TagsMode; label: string }[] => [
  { value: "none", label: t("push.tags.none") },
  { value: "follow", label: t("push.tags.follow") },
  { value: "all", label: t("push.tags.all") },
];

export function PushDialog() {
  const model = createPushModel();
  const [editAll, setEditAll] = createSignal(false);
  const [forceOpen, setForceOpen] = createSignal(false);
  const open = () => !!pushDialogRequest();

  createEffect(on(pushDialogRequest, (request) => request && model.open(request.preselected)));

  const checked = () => model.checkedPlans().length;
  const run = async (force: boolean) => {
    const result = await model.start(force);
    if (result) closePushDialog();
  };

  return (
    <>
      <Dialog
        open={open()}
        onClose={closePushDialog}
        size="xl"
        class="push-dialog"
        initialFocus={() => document.querySelector<HTMLElement>('.push-dialog [role="tree"] [tabindex="0"]')}
        title={t("push.title")}
        closeOnEscape={!model.running()}
        closeOnBackdrop={!model.running()}
        hideClose={model.running()}
        footer={
          <>
            <Show when={model.state.phase === "ready" || model.state.phase === "error"}>
              <IconButton
                class="push-dialog__refresh"
                icon={RefreshCw}
                label={t("push.recheck")}
                tooltip={t("push.recheckTip")}
                disabled={model.running()}
                onClick={() => void model.reload()}
              />
            </Show>
            <span class="push-dialog__grow" />
            <Show
              when={model.running()}
              fallback={
                <Button variant="ghost" onClick={closePushDialog}>
                  {t("comp.cancel")}
                </Button>
              }
            >
              <Button variant="secondary" onClick={() => model.state.runId && void cancelRun(model.state.runId)}>
                {t("push.cancelPush")}
              </Button>
            </Show>
            <SplitButton
              icon={Upload}
              loading={model.running()}
              disabled={checked() === 0 || !!model.liveBlocked()}
              menuLabel={t("push.moreActions")}
              onClick={() => void run(false)}
              items={[{ label: t("push.forceItem"), icon: TriangleAlert, danger: true, disabled: checked() === 0 || !!model.liveBlocked(), onSelect: () => setForceOpen(true) }]}
            >
              {checked() > 1 ? t("push.pushMany", { n: checked() }) : t("push.push")}
            </SplitButton>
          </>
        }
      >
        <div class="push-body">
          <Show when={model.state.phase !== "error"} fallback={<EmptyState tone="danger" icon={CircleAlert} title={t("push.planFailed")} description={model.state.error} action={<Button onClick={() => void model.reload()}>{t("comp.tryAgain")}</Button>} />}>
            <div class="push-panes" data-busy={model.running() ? "" : undefined}>
              <div class="push-list">
                <div class="push-list__head">
                  <span>{t("push.repos")}</span>
                  <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditAll(true)} disabled={model.running() || !model.state.plans.length}>
                    {t("push.editAll")}
                  </Button>
                </div>
                <ScrollArea class="push-list__scroll">
                  <Show when={model.state.phase !== "loading" || model.state.plans.length} fallback={
                    <div class="push-loading" aria-busy="true" aria-label={t("push.loadingOutgoing")}>
                      <For each={[0, 1, 2, 3]}>{() => <Skeleton height={24} />}</For>
                    </div>
                  }>
                    <CommitsTree model={model} />
                  </Show>
                </ScrollArea>
              </div>
              <FilesPane model={model} />
            </div>
            <Show when={model.state.notice}>
              <p class="push-notice" role="alert">
                {model.state.notice}
              </p>
            </Show>
            <Show when={model.liveRows().length}>
              <section class="push-live" aria-label={t("push.liveAria")}>
                <p class="push-live__title">
                  <Icon icon={Lock} size={14} /> {t("push.liveTitle", { n: model.liveRows().length })}
                </p>
                <For each={model.liveRows()}>
                  {(row, i) => (
                    <label class="push-live__row">
                      <span>{tRich(model.liveRows().length > 1 ? "push.liveTypeRepo" : "push.liveType", { branch: <strong class="ui-mono">{row.branch}</strong> }, { repo: row.repoName })}</span>
                      <Input
                        size="sm"
                        data-autofocus={i() === 0 || undefined}
                        value={model.state.confirm[row.repoId] ?? ""}
                        onInput={(e) => model.setConfirm(row.repoId, e.currentTarget.value)}
                        invalid={!!model.state.confirm[row.repoId] && model.state.confirm[row.repoId] !== row.branch}
                        spellcheck={false}
                        autocomplete="off"
                        disabled={model.running()}
                        aria-label={t("push.liveTypeAria", { branch: row.branch, repo: row.repoName })}
                      />
                    </label>
                  )}
                </For>
                <Show when={!runGitHooks()}>
                  <p class="push-live__hint" role="alert">
                    {t("push.liveHooks")}
                  </p>
                </Show>
              </section>
            </Show>
            <div class="push-options">
              <div class="push-options__group">
                <span class="push-options__label" id="push-tags-label">
                  {t("push.tags")}
                </span>
                <SegmentedControl size="sm" aria-label={t("push.tags")} value={pushTags()} onChange={setPushTags} options={tagOptions()} />
              </div>
              <Switch size="sm" label={t("push.hooks")} checked={runGitHooks()} onChange={setRunGitHooks} />
              <Switch size="sm" label={t("push.preview")} checked={previewNonProtected()} onChange={setPreviewNonProtected} />
            </div>
          </Show>
        </div>
      </Dialog>
      <EditAllTargets open={editAll()} model={model} onClose={() => setEditAll(false)} />
      <ForceDialog
        open={forceOpen()}
        model={model}
        onClose={() => setForceOpen(false)}
        onConfirm={() => {
          setForceOpen(false);
          void run(true);
        }}
      />
    </>
  );
}
