import { batch, createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { t } from "../../i18n";
import type { WorkspaceSummary } from "../../ipc/workspaces";
import {
  activeId,
  duplicateWorkspace,
  isPinned,
  recolorWorkspace,
  removeWorkspace,
  renameWorkspace,
  reorderWorkspaces,
  requestSwitch,
  workspaces,
} from "../../store/workspaces";
import { Button, ChevronDown, ChevronUp, Dialog, Ellipsis, IconButton, Input, Menu, Popover, REPO_PALETTE, RepoBadge, toast } from "../../ui-kit";
import { announce } from "../../ui-kit";
import { closeManage, manageOpen } from "./dialogs";
import { workspaceErrorText } from "./errors";
import { uniqueName } from "./format";

const byOrder = (a: WorkspaceSummary, b: WorkspaceSummary): number => a.order - b.order;
const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Manage workspaces (3.8): rename (double-click or F2), recolour (swatches or a hex), duplicate, reorder (Alt+Up/Down or the
 * arrow buttons) and remove with a confirmation that says nothing on disk is touched.
 */
export function ManageDialog() {
  const [editing, setEditing] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");
  const [error, setError] = createSignal("");
  const [removing, setRemoving] = createSignal<WorkspaceSummary | null>(null);
  const [menuFor, setMenuFor] = createSignal<string | null>(null);
  const rows = createMemo(() => [...workspaces()].sort(byOrder));
  const pinned = isPinned;
  let listEl: HTMLUListElement | undefined;

  // A command can start on a specific workspace: rename it, change its colour, or ask to remove it.
  createEffect(
    on(manageOpen, (req) => {
      setError("");
      setEditing(null);
      setRemoving(null);
      if (!req?.id) return;
      const w = workspaces().find((x) => x.id === req.id);
      if (!w) return;
      if (req.action === "rename") startEdit(w);
      if (req.action === "remove") setRemoving(w);
    }),
  );

  function startEdit(w: WorkspaceSummary) {
    if (pinned()) return;
    batch(() => {
      setEditing(w.id);
      setDraft(w.name);
      setError("");
    });
    queueMicrotask(() => listEl?.querySelector<HTMLInputElement>(`[data-edit="${CSS.escape(w.id)}"]`)?.select());
  }

  async function commitEdit(w: WorkspaceSummary) {
    const name = draft().trim();
    if (!name) return setError(t("manage.nameEmpty"));
    if ([...name].length > 60) return setError(t("manage.nameLong"));
    if (name === w.name) return setEditing(null);
    try {
      await renameWorkspace(w.id, name);
      setEditing(null);
      toast.success(t("ws.toast.renamed", { name }));
      queueMicrotask(() => listEl?.querySelector<HTMLElement>(`[data-name="${CSS.escape(w.id)}"]`)?.focus());
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(code === "duplicateName" ? t("manage.nameTaken") : workspaceErrorText(e));
    }
  }

  async function recolor(w: WorkspaceSummary, color: string) {
    try {
      await recolorWorkspace(w.id, color);
      announce(t("ws.toast.recoloured"));
    } catch (e) {
      setError(workspaceErrorText(e));
    }
  }

  async function duplicate(w: WorkspaceSummary) {
    try {
      const copy = await duplicateWorkspace(w.id, uniqueName(t("manage.copyName", { name: w.name }), workspaces().map((x) => x.name)));
      toast.success(t("ws.toast.duplicated", { name: copy.name }));
    } catch (e) {
      setError(workspaceErrorText(e));
    }
  }

  async function move(w: WorkspaceSummary, delta: -1 | 1) {
    const ids = rows().map((r) => r.id);
    const from = ids.indexOf(w.id);
    const to = from + delta;
    if (pinned() || from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    try {
      await reorderWorkspaces(ids);
      announce(t("manage.moved", { name: w.name, position: to + 1, total: ids.length }));
      queueMicrotask(() => listEl?.querySelector<HTMLElement>(`[data-name="${CSS.escape(w.id)}"]`)?.focus());
    } catch (e) {
      setError(workspaceErrorText(e));
    }
  }

  async function confirmRemove(w: WorkspaceSummary) {
    setRemoving(null);
    try {
      const outcome = await removeWorkspace(w.id);
      if (outcome === "removed") toast.success(t("ws.toast.removed", { name: w.name }));
    } catch (e) {
      setError(workspaceErrorText(e));
    }
  }

  function menuItems(w: WorkspaceSummary) {
    return [
      { label: t("manage.open"), disabled: w.id === activeId() || pinned(), onSelect: () => (closeManage(), void requestSwitch(w.id)) },
      { label: t("manage.rename"), disabled: pinned(), onSelect: () => startEdit(w) },
      { label: t("manage.duplicate"), disabled: pinned(), onSelect: () => void duplicate(w) },
      { type: "separator" as const },
      { label: t("manage.remove"), danger: true, disabled: pinned(), onSelect: () => setRemoving(w) },
    ];
  }

  return (
    <>
      <Dialog
        open={manageOpen() !== null}
        onClose={closeManage}
        title={t("manage.title")}
        size="lg"
        footer={<Button variant="secondary" onClick={closeManage}>{t("manage.close")}</Button>}
      >
        <Show when={pinned()}>
          <p class="manage__note">{t("manage.pinnedNote")}</p>
        </Show>
        <Show when={error()}>
          <p class="manage__error" role="alert">{error()}</p>
        </Show>
        <Show when={rows().length > 0} fallback={<p class="manage__empty">{t("manage.empty")}</p>}>
          <ul class="manage" role="list" ref={listEl}>
            <For each={rows()}>
              {(w, index) => (
                <li class="manage__row" data-active={w.id === activeId() ? "" : undefined}>
                  <Popover
                    aria-label={t("manage.colorOf", { name: w.name })}
                    placement="bottom-start"
                    trigger={(tp) => (
                      <button {...tp} type="button" class="manage__swatch" disabled={pinned()} style={{ "--wc": w.color }} aria-label={t("manage.colorOf", { name: w.name })} />
                    )}
                  >
                    {(api) => (
                      <div class="manage__palette" role="radiogroup" aria-label={t("manage.color")}>
                        <For each={REPO_PALETTE}>
                          {(c) => (
                            <button
                              type="button"
                              role="radio"
                              aria-checked={c === w.color}
                              aria-label={c}
                              class="manage__chip"
                              style={{ "--wc": c }}
                              onClick={() => (api.close(), void recolor(w, c))}
                            />
                          )}
                        </For>
                        <Input
                          size="sm"
                          class="manage__hex"
                          aria-label={t("manage.color")}
                          placeholder="#8b6cf0"
                          value={w.color}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && HEX.test(e.currentTarget.value)) {
                              api.close();
                              void recolor(w, e.currentTarget.value);
                            }
                          }}
                        />
                      </div>
                    )}
                  </Popover>
                  <div class="manage__main">
                    <Show
                      when={editing() === w.id}
                      fallback={
                        <button
                          type="button"
                          class="manage__name"
                          data-name={w.id}
                          onDblClick={() => startEdit(w)}
                          onKeyDown={(e) => {
                            if (e.key === "F2") (e.preventDefault(), startEdit(w));
                            if (e.altKey && e.key === "ArrowUp") (e.preventDefault(), void move(w, -1));
                            if (e.altKey && e.key === "ArrowDown") (e.preventDefault(), void move(w, 1));
                            if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) (e.preventDefault(), setMenuFor(w.id));
                          }}
                        >
                          {w.name}
                          <Show when={w.id === activeId()}>
                            <span class="manage__open">{t("manage.current")}</span>
                          </Show>
                        </button>
                      }
                    >
                      <form
                        class="manage__edit"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void commitEdit(w);
                        }}
                      >
                        <Input
                          data-edit={w.id}
                          size="sm"
                          value={draft()}
                          invalid={!!error()}
                          aria-label={t("manage.name")}
                          onInput={(e) => (setDraft(e.currentTarget.value), setError(""))}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") {
                              e.stopPropagation();
                              setEditing(null);
                              setError("");
                              queueMicrotask(() => listEl?.querySelector<HTMLElement>(`[data-name="${CSS.escape(w.id)}"]`)?.focus());
                            }
                          }}
                        />
                      </form>
                    </Show>
                    <span class="manage__repos" aria-label={t("switch.repos", { count: w.repos.length })}>
                      <For each={w.repos.slice(0, 6)}>{(r) => <RepoBadge color={r.color} badge={r.badge} size={16} />}</For>
                      <Show when={w.repos.length > 6}>
                        <span class="manage__more">+{w.repos.length - 6}</span>
                      </Show>
                      <Show when={w.repos.length === 0}>
                        <span class="manage__more">{t("switch.repos", { count: 0 })}</span>
                      </Show>
                    </span>
                  </div>
                  <div class="manage__tools">
                    <IconButton icon={ChevronUp} size="sm" label={t("manage.moveUp", { name: w.name })} disabled={pinned() || index() === 0} onClick={() => void move(w, -1)} />
                    <IconButton icon={ChevronDown} size="sm" label={t("manage.moveDown", { name: w.name })} disabled={pinned() || index() === rows().length - 1} onClick={() => void move(w, 1)} />
                    <Menu
                      aria-label={t("welcome.recent.more", { name: w.name })}
                      placement="bottom-end"
                      open={menuFor() === w.id}
                      onOpenChange={(o) => setMenuFor(o ? w.id : null)}
                      items={menuItems(w)}
                      trigger={(tp) => <IconButton {...tp} icon={Ellipsis} size="sm" label={t("welcome.recent.more", { name: w.name })} />}
                    />
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={editing() && error()}>
          <p class="manage__error" role="alert">{error()}</p>
        </Show>
      </Dialog>
      <Dialog
        open={removing() !== null}
        onClose={() => setRemoving(null)}
        title={t("manage.removeTitle", { name: removing()?.name ?? "" })}
        description={t("manage.removeBody")}
        size="sm"
        role="alertdialog"
        initialFocus={() => document.querySelector<HTMLElement>("[data-manage-cancel]")}
        footer={
          <>
            <Button variant="ghost" data-manage-cancel onClick={() => setRemoving(null)}>{t("manage.cancel")}</Button>
            <Button variant="danger" onClick={() => removing() && void confirmRemove(removing()!)}>{t("manage.removeConfirm")}</Button>
          </>
        }
      />
    </>
  );
}

export default ManageDialog;
