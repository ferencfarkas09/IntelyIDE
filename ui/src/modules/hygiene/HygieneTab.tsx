import { createEffect, createMemo, createResource, createSignal, For, on, Show, type JSX } from "solid-js";
import { t } from "../../i18n";
import { repoName } from "../../store/actions";
import { repos } from "../../store/workspace";
import { AheadBehind, Badge, Button, Dialog, EmptyState, GitBranch, Icon, IconButton, Input, Lock, Plus, RefreshCw, SegmentedControl, Select, Skeleton, Tag, toast, Trash2, TriangleAlert } from "../../ui-kit";
import { hygieneApi } from "./api";
import { ageText, branchMatrix, confirmed, countsOf, errorText, filterBranches, validWorktreeName, type BranchFilter } from "./logic";
import type { BranchRow, Hygiene, WorktreeRow } from "./types";
import "./hygiene.css";

type View = "branches" | "matrix" | "tags" | "worktrees";

/** A destructive action behind a typed name: the button stays off until the exact text is in the field. */
function TypedConfirm(props: { open: boolean; title: string; description: JSX.Element; name: string; action: string; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const [typed, setTyped] = createSignal("");
  createEffect(on(() => props.open, () => setTyped("")));
  const typeParts = () => t("hygiene.typeConfirm", { name: "\u0001" }).split("\u0001");
  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      role="alertdialog"
      size="sm"
      title={props.title}
      description={props.description}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>{t("hygiene.cancel")}</Button>
          <Button variant="danger" icon={Trash2} loading={props.busy} disabled={!confirmed(typed(), props.name)} onClick={props.onConfirm}>{props.action}</Button>
        </>
      }
    >
      <label class="hy__confirm">
        <span>{typeParts()[0]}<code class="ui-mono">{props.name}</code>{typeParts()[1]}</span>
        <Input data-autofocus aria-label={t("hygiene.typeAria", { name: props.name })} value={typed()} onInput={(e) => setTyped(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && confirmed(typed(), props.name) && props.onConfirm()} spellcheck={false} autocomplete="off" />
      </label>
    </Dialog>
  );
}

function BranchList(props: { report: Hygiene; onDelete: (b: BranchRow) => void }) {
  const [filter, setFilter] = createSignal<BranchFilter>("all");
  const counts = () => countsOf(props.report.branches);
  const rows = () => filterBranches(props.report.branches, filter());
  const mergedParts = () => t("hygiene.mergedInto", { branch: "\u0001", days: props.report.staleDays }).split("\u0001");
  return (
    <>
      <div class="hy__filters">
        <SegmentedControl
          size="sm"
          aria-label={t("hygiene.filter.aria")}
          value={filter()}
          onChange={setFilter}
          options={[
            { value: "all", label: t("hygiene.filter.all", { n: counts().all }) },
            { value: "merged", label: t("hygiene.filter.merged", { n: counts().merged }) },
            { value: "stale", label: t("hygiene.filter.stale", { n: counts().stale }) },
            { value: "gone", label: t("hygiene.filter.gone", { n: counts().gone }) },
          ]}
        />
        <span class="hy__hint">{mergedParts()[0]}<code class="ui-mono">{props.report.defaultBranch ?? "?"}</code>{mergedParts()[1]}</span>
      </div>
      <Show when={rows().length} fallback={<EmptyState size="sm" icon={GitBranch} title={t("hygiene.empty.title")} description={t("hygiene.empty.desc")} />}>
        <ul class="hy__list" aria-label={t("hygiene.branches.aria")}>
          <For each={rows()}>
            {(b) => (
              <li class="hy__row" data-branch={b.name}>
                <div class="hy__main">
                  <span class="hy__name ui-mono ui-truncate" title={b.name}>{b.name}</span>
                  <span class="hy__sub ui-truncate" title={b.subject}>{b.subject}</span>
                </div>
                <div class="hy__badges">
                  <Show when={b.current}><Badge size="sm" tone="accent">{t("hygiene.badge.current")}</Badge></Show>
                  <Show when={b.protected}><Badge size="sm" tone="neutral" icon={Lock}>{t("hygiene.badge.protected")}</Badge></Show>
                  <Show when={b.merged && !b.current}><Badge size="sm" tone="ok">{t("hygiene.badge.merged")}</Badge></Show>
                  <Show when={b.upstreamGone}><Badge size="sm" tone="warn">{t("hygiene.badge.gone")}</Badge></Show>
                  <Show when={b.stale}><Badge size="sm" tone="warn">{t("hygiene.badge.stale")}</Badge></Show>
                </div>
                <AheadBehind ahead={b.ahead} behind={b.behind} />
                <span class="hy__age ui-tnum" title={new Date(b.lastCommitTs * 1000).toLocaleString()}>{ageText(b.ageDays)}</span>
                <IconButton icon={Trash2} label={b.deletable ? t("hygiene.deleteName", { name: b.name }) : t("hygiene.cannotDelete", { name: b.name, reason: b.blocked ?? t("hygiene.blocked") })} tooltip={b.deletable ? t("hygiene.deleteTip") : (b.blocked ?? "")} size="sm" disabled={!b.deletable} onClick={() => props.onDelete(b)} />
              </li>
            )}
          </For>
        </ul>
      </Show>
    </>
  );
}

function Matrix() {
  const [reports] = createResource(async () => Promise.all(repos().map((r) => hygieneApi().report(r.id))));
  const rows = createMemo(() => branchMatrix(reports() ?? []));
  return (
    <Show when={reports()} fallback={<Skeleton height={80} />}>
      {(rs) => (
        <div class="hy__matrix-wrap">
          <table class="hy__matrix" aria-label={t("hygiene.matrix.aria")}>
            <thead>
              <tr>
                <th scope="col">{t("hygiene.matrix.branch")}</th>
                <For each={rs()}>{(r) => <th scope="col">{repoName(r.repoId)}</th>}</For>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(row) => (
                  <tr>
                    <th scope="row" class="ui-mono">{row.name}</th>
                    <For each={row.cells}>
                      {(c) => (
                        <td>
                          <Show when={c} fallback={<span class="hy__none">–</span>}>
                            <Show when={c!.ahead || c!.behind} fallback={<span class="hy__sync">{c!.merged ? t("hygiene.badge.merged") : t("hygiene.inSync")}</span>}>
                              <AheadBehind ahead={c!.ahead} behind={c!.behind} />
                            </Show>
                          </Show>
                        </td>
                      )}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <p class="hy__hint">{t("hygiene.matrix.hint")}</p>
        </div>
      )}
    </Show>
  );
}

function Tags(props: { report: Hygiene }) {
  return (
    <Show when={props.report.tags.length} fallback={<EmptyState size="sm" icon={Tag} title={t("hygiene.tags.empty")} description={t("hygiene.tags.emptyDesc")} />}>
      <ul class="hy__list" aria-label={t("hygiene.tags.aria")}>
        <For each={props.report.tags}>
          {(tg) => (
            <li class="hy__row hy__row--tag">
              <div class="hy__main">
                <span class="hy__name ui-mono">{tg.name}</span>
                <span class="hy__sub ui-truncate">{tg.subject}</span>
              </div>
              <Badge size="sm" tone={tg.annotated ? "info" : "neutral"}>{tg.annotated ? t("hygiene.tags.annotated") : t("hygiene.tags.lightweight")}</Badge>
              <span class="hy__age ui-tnum">{new Date(tg.ts * 1000).toLocaleDateString()}</span>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}

function Worktrees(props: { repoId: string }) {
  const [list, { refetch }] = createResource(() => props.repoId, (id) => hygieneApi().worktrees(id));
  const [removing, setRemoving] = createSignal<WorktreeRow | undefined>(undefined);
  const [creating, setCreating] = createSignal(false);
  const [name, setName] = createSignal("");
  const [base, setBase] = createSignal("");
  const [typed, setTyped] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const label = (w: WorktreeRow) => (w.main ? t("hygiene.wt.main") : w.owned ? t("hygiene.wt.owned") : w.external === "cursor" ? t("hygiene.wt.cursor") : t("hygiene.wt.other"));
  async function create() {
    setBusy(true);
    try {
      const w = await hygieneApi().createWorktree(props.repoId, name(), base().trim() || null, typed());
      toast.success(t("hygiene.wt.created"), w.branch ? t("hygiene.wt.createdOn", { name: w.name, branch: w.branch }) : t("hygiene.wt.createdDetached", { name: w.name }));
      setCreating(false);
      setName("");
      setBase("");
      setTyped("");
      void refetch();
    } catch (e) {
      toast.error(t("hygiene.wt.createFailed"), errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    const w = removing();
    if (!w) return;
    setBusy(true);
    try {
      toast.success(t("hygiene.wt.removed"), await hygieneApi().removeWorktree(props.repoId, w.path, w.name));
      setRemoving(undefined);
      void refetch();
    } catch (e) {
      toast.error(t("hygiene.wt.removeFailed"), errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div class="hy__filters">
        <span class="hy__hint">{t("hygiene.wt.hint")}</span>
        <span class="hy__spacer" />
        <Button size="sm" variant="secondary" icon={Plus} onClick={() => setCreating(true)}>{t("hygiene.wt.new")}</Button>
      </div>
      <Show when={list()} fallback={<Skeleton height={60} />}>
        {(rows) => (
          <ul class="hy__list" aria-label={t("hygiene.wt.aria")}>
            <For each={rows()}>
              {(w) => (
                <li class="hy__row" data-worktree={w.name} data-owned={w.owned ? "" : undefined}>
                  <div class="hy__main">
                    <span class="hy__name ui-mono ui-truncate" title={w.path}>{w.name}</span>
                    <span class="hy__sub ui-truncate" title={w.path}>{w.path}</span>
                  </div>
                  <div class="hy__badges">
                    <Badge size="sm" tone={w.owned ? "accent" : "neutral"} icon={w.owned ? undefined : Lock}>{label(w)}</Badge>
                    <Show when={w.locked}><Badge size="sm" tone="warn">{t("hygiene.wt.locked")}</Badge></Show>
                    <Show when={w.prunable}><Badge size="sm" tone="warn" icon={TriangleAlert}>{t("hygiene.wt.missing")}</Badge></Show>
                  </div>
                  <span class="hy__sub ui-mono">{w.branch ?? t("hygiene.wt.detached", { head: w.head.slice(0, 7) })}</span>
                  <IconButton icon={Trash2} label={w.owned ? t("hygiene.wt.removeName", { name: w.name }) : t("hygiene.wt.cannotRemove", { name: w.name })} tooltip={w.owned ? t("hygiene.wt.removeTip") : t("hygiene.wt.notOwned")} size="sm" disabled={!w.owned} onClick={() => setRemoving(w)} />
                </li>
              )}
            </For>
          </ul>
        )}
      </Show>
      <TypedConfirm open={!!removing()} title={t("hygiene.wt.removeTitle")} description={t("hygiene.wt.removeDesc")} name={removing()?.name ?? ""} action={t("hygiene.wt.removeAction")} busy={busy()} onClose={() => setRemoving(undefined)} onConfirm={() => void remove()} />
      <Dialog
        open={creating()}
        onClose={() => setCreating(false)}
        size="sm"
        title={t("hygiene.wt.new")}
        description={t("hygiene.wt.newDesc")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>{t("hygiene.cancel")}</Button>
            <Button variant="primary" icon={Plus} loading={busy()} disabled={!validWorktreeName(name()) || !confirmed(typed(), name())} onClick={() => void create()}>{t("hygiene.wt.create")}</Button>
          </>
        }
      >
        <div class="hy__form">
          <label class="hy__confirm"><span>{t("hygiene.wt.name")}</span><Input data-autofocus aria-label={t("hygiene.wt.nameAria")} value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="run-43" spellcheck={false} invalid={name() !== "" && !validWorktreeName(name())} /></label>
          <label class="hy__confirm"><span>{t("hygiene.wt.base")}</span><Input aria-label={t("hygiene.wt.baseAria")} value={base()} onInput={(e) => setBase(e.currentTarget.value)} placeholder="HEAD" spellcheck={false} /></label>
          <label class="hy__confirm"><span>{t("hygiene.wt.typeAgain")}</span><Input aria-label={t("hygiene.wt.typeAgainAria")} value={typed()} onInput={(e) => setTyped(e.currentTarget.value)} spellcheck={false} autocomplete="off" /></label>
        </div>
      </Dialog>
    </>
  );
}

/** Branch hygiene and worktrees: merged and stale branches, safe delete, tags, an ahead/behind matrix and the worktree list. */
export default function HygieneTab() {
  const list = createMemo(() => repos());
  const [picked, setPicked] = createSignal<string | undefined>(undefined);
  const repoId = () => picked() ?? list()[0]?.id ?? "";
  const [view, setView] = createSignal<View>("branches");
  const [report, { refetch }] = createResource(repoId, async (id) => (id ? hygieneApi().report(id) : undefined));
  const [deleting, setDeleting] = createSignal<BranchRow | undefined>(undefined);
  const [busy, setBusy] = createSignal(false);
  async function del() {
    const b = deleting();
    if (!b) return;
    setBusy(true);
    try {
      toast.success(t("hygiene.deleted"), await hygieneApi().deleteBranch(repoId(), b.name, b.name));
      setDeleting(undefined);
      void refetch();
    } catch (e) {
      toast.error(t("hygiene.deleteFailed"), errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="hy">
      <div class="hy__bar">
        <h2 class="hy__title">{t("hygiene.name")}</h2>
        <Select aria-label={t("hygiene.repo")} size="sm" value={repoId()} onChange={setPicked} options={list().map((r) => ({ value: r.id, label: r.name }))} />
        <SegmentedControl
          size="sm"
          aria-label={t("hygiene.view")}
          value={view()}
          onChange={setView}
          options={[
            { value: "branches", label: t("hygiene.view.branches") },
            { value: "matrix", label: t("hygiene.view.matrix") },
            { value: "tags", label: t("hygiene.view.tags") },
            { value: "worktrees", label: t("hygiene.view.worktrees") },
          ]}
        />
        <span class="hy__spacer" />
        <Show when={view() !== "worktrees" && view() !== "matrix"}>
          <Button size="sm" variant="secondary" icon={RefreshCw} loading={report.loading} onClick={() => void refetch()}>{t("hygiene.refresh")}</Button>
        </Show>
      </div>
      <Show when={report.error}>
        <p class="hy__error" role="alert">{errorText(report.error)}</p>
      </Show>
      <Show when={view() === "branches"}>
        <Show when={report()} fallback={<Skeleton height={120} />}>{(r) => <BranchList report={r()} onDelete={setDeleting} />}</Show>
      </Show>
      <Show when={view() === "matrix"}><Matrix /></Show>
      <Show when={view() === "tags"}>
        <Show when={report()} fallback={<Skeleton height={80} />}>{(r) => <Tags report={r()} />}</Show>
      </Show>
      <Show when={view() === "worktrees" && repoId()}><Worktrees repoId={repoId()} /></Show>
      <TypedConfirm open={!!deleting()} title={t("hygiene.del.title")} description={t("hygiene.del.desc")} name={deleting()?.name ?? ""} action={t("hygiene.del.action")} busy={busy()} onClose={() => setDeleting(undefined)} onConfirm={() => void del()} />
    </div>
  );
}
