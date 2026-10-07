import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { registerDropTarget } from "../../platform/dropzone";
import { saveWorkspace, repos, workspace } from "../../store/workspace";
import { errorText } from "../../store/snapshots";
import { REPO_PALETTE, Button, ChevronDown, ChevronUp, IconButton, MiddleEllipsis, Plus, RepoBadge, Search, Trash2, toast } from "../../ui-kit";
import type { Workspace } from "../../ipc";
import { execute } from "../../platform/commands";
import { workspaceErrorText } from "../../shell/workspace/errors";
import { addPickedRepos } from "../../shell/workspace/flows";
import { openPicker } from "../../shell/workspace/pickerBridge";
import { moveRepo, removeRepo, repoAlreadyIn, setRepoColor } from "./repos";

/** Workspace repos: add, remove, reorder and recolour. Every edit saves the workspace at once. */
export function RepoList() {
  const [colourFor, setColourFor] = createSignal<string | null>(null);
  const [removing, setRemoving] = createSignal<string | null>(null);
  const [problem, setProblem] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  // The Rust drop inbox hands over validated folders (picker:drop); the router target keeps attachments from taking them.
  onMount(() => {
    const offTarget = registerDropTarget({ id: "settings.repoList", priority: 80, label: t("general.repos"), title: t("switch.add"), accepts: () => true, isActive: () => true, onDrop: () => undefined });
    void ipc.picker.dropListen(true).catch(() => undefined);
    const offDrop = ipc.picker.onDrop(() => void ipc.picker.takeDrop().then((items) => addPicked(items)).catch(() => undefined));
    onCleanup(() => {
      offTarget();
      offDrop();
      void ipc.picker.dropListen(false).catch(() => undefined);
    });
  });

  async function save(change: (ws: Workspace) => Workspace) {
    const ws = workspace();
    if (!ws) return;
    try {
      await saveWorkspace(change(ws));
    } catch (e) {
      toast.error(t("repos.saveFailed"), errorText(e));
    }
  }

  /** Adds validated folders: a repository that is already in the workspace is refused inline, before and after Rust looks. */
  async function addPicked(items: Awaited<ReturnType<typeof openPicker>>) {
    const ws = workspace();
    if (!ws || !items?.length) return;
    setProblem("");
    const dup = items.find((p) => repoAlreadyIn(ws, p.path));
    if (dup) return setProblem(t("ws.error.alreadyInWorkspace"));
    setBusy(true);
    try {
      await addPickedRepos(items);
    } catch (e) {
      setProblem(workspaceErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function addByPicker() {
    setProblem("");
    try {
      await addPicked(await openPicker({ kind: "folders", purpose: "workspaceRepo" }));
    } catch (e) {
      setProblem(workspaceErrorText(e));
    }
  }

  return (
    <div class="repolist">
      <ul class="repolist__rows" aria-label={t("repos.list")}>
        <For each={repos()} fallback={<li class="repolist__empty">{t("repos.empty")}</li>}>
          {(repo, index) => (
            <li class="repolist__item">
              <div class="repolist__row">
                <button
                  type="button"
                  class="repolist__dot"
                  aria-label={t("repos.colourOf", { name: repo.name })}
                  aria-expanded={colourFor() === repo.id}
                  onClick={() => setColourFor(colourFor() === repo.id ? null : repo.id)}
                >
                  <RepoBadge color={repo.color} badge={repo.badge} size={24} />
                </button>
                <span class="repolist__text">
                  <span class="repolist__name ui-truncate">{repo.name}</span>
                  <span class="repolist__path"><MiddleEllipsis text={repo.path} /></span>
                </span>
                <IconButton icon={ChevronUp} label={t("repos.moveUp", { name: repo.name })} size="sm" disabled={index() === 0} onClick={() => void save((w) => moveRepo(w, repo.id, -1))} />
                <IconButton icon={ChevronDown} label={t("repos.moveDown", { name: repo.name })} size="sm" disabled={index() === repos().length - 1} onClick={() => void save((w) => moveRepo(w, repo.id, 1))} />
                <IconButton icon={Trash2} label={t("repos.remove", { name: repo.name })} size="sm" onClick={() => setRemoving(removing() === repo.id ? null : repo.id)} />
              </div>
              <Show when={colourFor() === repo.id}>
                <div class="repolist__swatches" role="group" aria-label={t("repos.colours", { name: repo.name })}>
                  <For each={REPO_PALETTE}>
                    {(color) => (
                      <button
                        type="button"
                        class="repolist__swatch"
                        style={{ "--rc": color }}
                        aria-label={color}
                        aria-pressed={repo.color.toLowerCase() === color}
                        onClick={() => void save((w) => setRepoColor(w, repo.id, color))}
                      />
                    )}
                  </For>
                </div>
              </Show>
              <Show when={removing() === repo.id}>
                <div class="repolist__confirm" role="alert">
                  <span>{t("repos.confirm", { name: repo.name })}</span>
                  <Button size="sm" variant="danger" onClick={() => void save((w) => removeRepo(w, repo.id)).then(() => setRemoving(null))}>{t("repos.removeBtn")}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>{t("repos.cancel")}</Button>
                </div>
              </Show>
            </li>
          )}
        </For>
      </ul>
      <div class="repolist__add" role="group" aria-label={t("repos.addForm")}>
        <Button size="sm" icon={Plus} loading={busy()} onClick={() => void addByPicker()}>{t("ws.emptyAdd")}</Button>
        <Button size="sm" variant="ghost" icon={Search} onClick={() => void execute("workspace.scan", { target: "current" })}>{t("ws.emptyScan")}</Button>
        <Show when={problem()}>{(p) => <p class="repolist__problem" role="alert">{p()}</p>}</Show>
      </div>
    </div>
  );
}
