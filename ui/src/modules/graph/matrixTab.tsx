import { createResource, createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { BranchMatrix, SameBranchResult } from "../../ipc/graph";
import { setToolWindow } from "../../platform/rail";
import { refreshSnapshots } from "../../store/snapshots";
import { repoConfig, repos } from "../../store/workspace";
import { AheadBehind, Badge, Button, EmptyState, GitBranch, Icon, IconButton, Input, Layers, RefreshCw, Skeleton, toast, Trash2 } from "../../ui-kit";
import { validBranchName } from "./branchName";
import { shortOid } from "./format";
import "./graph.css";
import { setSelection } from "./logState";
import { errorMessage } from "./ops";

const nameOf = (repoId: string) => repoConfig(repoId)?.name ?? repoId;

const MAIN = ["main", "master", "develop"];
/** The matrix columns with the main branches first. */
export const orderedBranches = (m: BranchMatrix) => m.branches.slice().sort((a, b) => (MAIN.includes(a.name) ? MAIN.indexOf(a.name) : 99) - (MAIN.includes(b.name) ? MAIN.indexOf(b.name) : 99) || a.name.localeCompare(b.name));

/** Repos of the matrix that lack / have a branch. */
export const reposWithout = (m: BranchMatrix, name: string): string[] => m.repos.map((r) => r.repoId).filter((id) => !m.branches.find((b) => b.name === name)?.cells[id]?.exists);
export const reposWith = (m: BranchMatrix, name: string): string[] => m.repos.map((r) => r.repoId).filter((id) => m.branches.find((b) => b.name === name)?.cells[id]?.exists);

/** Tab type `matrix`: which repo has which branch, create or switch a branch everywhere, and the bundles of linked commits. */
export default function MatrixTab() {
  const ids = () => repos().map((r) => r.id);
  const [matrix, { refetch }] = createResource(ids, (repoIds) => ipc.graph.branchMatrix(repoIds));
  const [bundles, { refetch: refetchBundles }] = createResource(ids, (repoIds) => ipc.graph.bundles(repoIds));
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const refresh = async () => {
    await Promise.all([refetch(), refetchBundles(), refreshSnapshots(null)]);
  };

  /** All-or-nothing calls: when a preflight fails nothing changed and `repos` says why. */
  const apply = async (label: string, work: () => Promise<SameBranchResult>) => {
    setBusy(true);
    try {
      const result = await work();
      if (result.applied) toast.success(label);
      else toast.error(t("graph.matrix.noChange"), result.repos.filter((r) => !r.ok).map((r) => `${nameOf(r.repoId)}: ${r.error?.message ?? t("graph.matrix.refused")}`).join("\n"));
    } catch (err) {
      toast.error(t("graph.matrix.opFailed"), errorMessage(err));
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const createEverywhere = async () => {
    const m = matrix();
    const branch = name().trim();
    if (!m || !validBranchName(branch)) return;
    const targets = reposWithout(m, branch);
    if (!targets.length) return void toast.info(t("graph.matrix.existsEverywhere", { branch }));
    await apply(t("graph.matrix.created", { branch, n: targets.length }), () => ipc.graph.sameBranchCreate(targets, branch));
    setName("");
  };

  const switchAll = (branch: string) => {
    const m = matrix();
    return m && apply(t("graph.matrix.switched", { branch }), () => ipc.graph.sameBranchSwitch(reposWith(m, branch), branch));
  };

  const showCommit = (repoId: string, oid: string) => {
    setSelection({ repoId, oid });
    setToolWindow("bottom", "graph");
  };

  const removeBundle = async (id: string) => {
    try {
      await ipc.graph.bundleRemove(id);
    } catch (err) {
      toast.error(t("graph.matrix.removeFail"), errorMessage(err));
    }
    await refetchBundles();
  };

  const invalid = () => name().trim() !== "" && !validBranchName(name().trim());

  return (
    <div class="gmatrix">
      <header class="gmatrix__head">
        <h2 class="gmatrix__title">{t("graph.matrix.title")}</h2>
        <form class="gmatrix__create" onSubmit={(e) => (e.preventDefault(), void createEverywhere())}>
          <Input size="sm" aria-label={t("graph.matrix.newName")} placeholder={t("graph.matrix.newPlaceholder")} invalid={invalid()} value={name()} onInput={(e) => setName(e.currentTarget.value)} />
          <Button size="sm" type="submit" variant="primary" icon={GitBranch} disabled={!name().trim() || invalid() || busy() || !matrix()} loading={busy()}>{t("graph.matrix.create")}</Button>
        </form>
        <IconButton icon={RefreshCw} size="sm" label={t("graph.matrix.reload")} loading={matrix.loading} onClick={() => void refresh()} />
      </header>

      <Show when={!matrix.error} fallback={<EmptyState tone="danger" size="sm" icon={GitBranch} title={t("graph.matrix.failed")} description={errorMessage(matrix.error)} action={<Button size="sm" onClick={() => void refetch()}>{t("graph.retry")}</Button>} />}>
        <Show when={matrix()} fallback={<div class="gmatrix__loading" aria-busy="true"><Skeleton height={16} width="60%" /><Skeleton height={16} width="45%" /></div>}>
          {(m) => (
            <Show when={m().branches.length > 0} fallback={<EmptyState size="sm" icon={GitBranch} title={t("graph.matrix.none")} description={t("graph.matrix.noneDesc")} />}>
              <div class="gmatrix__scroll">
                <table class="gmatrix__table">
                  <thead>
                    <tr>
                      <th scope="col">{t("graph.repository")}</th>
                      <For each={orderedBranches(m())}>
                        {(col) => {
                          const have = () => reposWith(m(), col.name);
                          const allThere = () => have().every((id) => col.cells[id]?.current);
                          return (
                            <th scope="col">
                              <div class="gmatrix__col">
                                <span class="ui-truncate" title={col.name}>{col.name}</span>
                                <span class="gmatrix__count ui-tnum">{have().length}/{m().repos.length}</span>
                                <Button size="sm" variant="ghost" disabled={busy() || have().length === 0 || allThere()} onClick={() => void switchAll(col.name)} title={t("graph.matrix.switchAllTip", { branch: col.name })}>{t("graph.matrix.switchAll")}</Button>
                              </div>
                            </th>
                          );
                        }}
                      </For>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={m().repos}>
                      {(repo) => (
                        <tr>
                          <th scope="row">
                            <span class="gmatrix__repo" style={{ "--repo": repoConfig(repo.repoId)?.color }}>{nameOf(repo.repoId)}</span>
                          </th>
                          <For each={orderedBranches(m())}>
                            {(col) => {
                              const cell = () => col.cells[repo.repoId];
                              return (
                                <td>
                                  <Show when={cell()?.exists} fallback={<span class="gmatrix__none" aria-label={t("graph.matrix.missing")}>-</span>}>
                                    <button
                                      type="button"
                                      class="gmatrix__cell"
                                      data-current={cell().current ? "" : undefined}
                                      disabled={busy() || cell().current}
                                      title={cell().gone ? t("graph.matrix.goneTip") : cell().upstream ?? undefined}
                                      aria-label={cell().current ? t("graph.matrix.cellCurrent", { branch: col.name, repo: nameOf(repo.repoId) }) : t("graph.matrix.cellSwitch", { branch: col.name, repo: nameOf(repo.repoId) })}
                                      onClick={() => void apply(t("graph.matrix.switchedRepo", { repo: nameOf(repo.repoId), branch: col.name }), () => ipc.graph.sameBranchSwitch([repo.repoId], col.name))}
                                    >
                                      <span class="gmatrix__dot" />
                                      <Show when={cell().current}><span>HEAD</span></Show>{/* i18n-ignore: git term */}
                                      <Show when={cell().ahead > 0 || cell().behind > 0}><AheadBehind ahead={cell().ahead} behind={cell().behind} /></Show>
                                      <Show when={cell().gone}><Badge size="sm" tone="warn">{t("graph.matrix.gone")}</Badge></Show>
                                    </button>
                                  </Show>
                                </td>
                              );
                            }}
                          </For>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </Show>
          )}
        </Show>
      </Show>

      <section class="gmatrix__bundles" aria-label={t("graph.matrix.bundles")}>
        <h3 class="gmatrix__subtitle"><Icon icon={Layers} size={14} /> {t("graph.matrix.bundles")}</h3>
        <Show when={(bundles() ?? []).length > 0} fallback={<p class="gmatrix__empty">{t("graph.matrix.noBundles")}</p>}>
          <For each={bundles()}>
            {(b) => (
              <article class="gmatrix__bundle">
                <header>
                  <strong>{b.name}</strong>
                  <Show when={b.branch}><Badge size="sm" icon={GitBranch}>{b.branch}</Badge></Show>
                  <Badge size="sm" tone={b.source === "recorded" ? "ok" : "neutral"} title={b.source === "recorded" ? t("graph.matrix.recordedTip") : t("graph.matrix.detectedTip")}>{b.source === "recorded" ? t("graph.matrix.recorded") : t("graph.matrix.detected")}</Badge>
                  <span class="gmatrix__count ui-tnum">{t("graph.matrix.reposN", { n: b.repoIds.length })}</span>
                  <span class="gmatrix__grow" />
                  <Show when={b.source === "recorded"}>
                    <IconButton icon={Trash2} size="sm" label={t("graph.matrix.forget", { name: b.name })} tooltip={t("graph.matrix.forgetTip")} onClick={() => void removeBundle(b.id)} />
                  </Show>
                </header>
                <ul>
                  <For each={b.commits}>
                    {(c) => (
                      <li>
                        <span class="gmatrix__repo" style={{ "--repo": repoConfig(c.repoId)?.color }}>{nameOf(c.repoId)}</span>
                        <button type="button" class="gmatrix__commit" disabled={c.missing} title={c.missing ? t("graph.matrix.rewritten") : undefined} onClick={() => showCommit(c.repoId, c.oid)}>
                          <code class="ui-mono">{shortOid(c.oid)}</code>
                          <span class="ui-truncate" classList={{ "ui-file-deleted": c.missing }}>{c.subject}</span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </article>
            )}
          </For>
        </Show>
      </section>
    </div>
  );
}
