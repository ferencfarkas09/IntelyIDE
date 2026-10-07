import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { fmt, t } from "../../i18n";
import { ipc } from "../../ipc";
import type { WorkspaceSummary } from "../../ipc/workspaces";
import { Button, Dialog, Ellipsis, EmptyState, FolderOpen, IconButton, Input, Menu, MiddleEllipsis, RepoBadge, toast, X, type MenuEntry } from "../../ui-kit";
import { announce } from "../../ui-kit";
import {
  duplicateWorkspace,
  firstBranch,
  forceOpen,
  isChecking,
  openError,
  probeOf,
  probeWorkspaces,
  recents,
  removeWorkspace,
  renameWorkspace,
  requestSwitch,
  rowStatus,
  workspaces,
  type RowStatus,
} from "../../store/workspaces";
import { badgeSplit, shortPath, uniqueName } from "./format";
import { workspaceErrorText } from "./errors";
import { locateFlow } from "./flows";

const INITIAL = 8;

const STATUS_KEYS = {
  checking: "welcome.recent.checking",
  missing: "welcome.recent.missing",
  volumeMissing: "welcome.recent.volume",
  notRepo: "welcome.recent.notRepo",
  noAccess: "welcome.recent.noAccess",
  unresponsive: "welcome.recent.unresponsive",
  fileDamaged: "welcome.recent.fileDamaged",
} as const;

/** Text of a row status; empty for a healthy row. */
export function statusText(s: RowStatus): string {
  if (s.kind === "ok") return "";
  if (s.kind === "someMissing") return t("welcome.recent.someMissing", { missing: s.missing, total: s.total });
  return t(STATUS_KEYS[s.kind]);
}

const isDead = (s: RowStatus): boolean => s.kind !== "ok" && s.kind !== "checking" && s.kind !== "someMissing" && s.total > 0;

const norm = (s: string): string => s.normalize("NFC").toLocaleLowerCase();

/**
 * The recent workspaces of the Welcome screen: a list of rows, each with one open button (roving focus, one tab stop) and
 * sibling action buttons. Typing filters, Delete asks inline before removing, the "..." menu holds the rest.
 */
export function RecentList(props: { hideEmpty?: boolean }) {
  const [filter, setFilter] = createSignal("");
  const [expanded, setExpanded] = createSignal(false);
  const [focused, setFocused] = createSignal<string | null>(null);
  const [removing, setRemoving] = createSignal<string | null>(null);
  const [menuFor, setMenuFor] = createSignal<string | null>(null);
  const [renaming, setRenaming] = createSignal<WorkspaceSummary | null>(null);
  const [rowError, setRowError] = createSignal<Record<string, string>>({});
  let list: HTMLUListElement | undefined;

  const all = recents;
  const matches = createMemo(() => {
    const q = norm(filter().trim());
    return q ? all().filter((w) => norm(w.name).includes(q)) : all();
  });
  const visible = createMemo(() => (expanded() || filter() ? matches() : matches().slice(0, INITIAL)));
  const rovingId = () => (visible().some((w) => w.id === focused()) ? focused() : (visible()[0]?.id ?? null));

  // Probing is lazy: only the rows on screen, again whenever the window regains focus (at most once per event).
  createEffect(on(() => visible().map((w) => w.id).join(","), () => void probeWorkspaces(visible().map((w) => w.id))));
  onMount(() => {
    const again = () => void probeWorkspaces(visible().map((w) => w.id));
    window.addEventListener("focus", again);
    onCleanup(() => window.removeEventListener("focus", again));
  });
  createEffect(on(() => filter(), (f) => f && announce(t("welcome.filterCount", { count: matches().length })), { defer: true }));

  const mains = () => [...(list?.querySelectorAll<HTMLButtonElement>(".recent__main") ?? [])];
  const focusRow = (id: string) => {
    setFocused(id);
    queueMicrotask(() => list?.querySelector<HTMLButtonElement>(`.recent__main[data-ws-id="${CSS.escape(id)}"]`)?.focus());
  };

  const statusOf = (w: WorkspaceSummary): RowStatus => rowStatus(w, probeOf(w.id), isChecking(w.id), openError()?.id === w.id && openError()?.reason === "fileDamaged");
  const effective = (w: WorkspaceSummary): RowStatus => {
    const s = statusOf(w);
    return openError()?.id === w.id && openError()?.reason === "allMissing" && s.kind === "ok" ? { kind: "missing", missing: w.repos.length, total: w.repos.length } : s;
  };

  async function activate(w: WorkspaceSummary) {
    const status = effective(w);
    setRowError((e) => ({ ...e, [w.id]: "" }));
    if (isDead(status)) {
      // A dead entry says why on its own row (and looks again), instead of a toast that vanishes.
      setRowError((e) => ({ ...e, [w.id]: statusText(status) }));
      void probeWorkspaces([w.id]);
      return;
    }
    try {
      if (openError()?.id === w.id) await forceOpen(w.id);
      else await requestSwitch(w.id);
    } catch (e) {
      setRowError((r) => ({ ...r, [w.id]: workspaceErrorText(e) }));
    }
  }

  /** Looks again; a flagged workspace whose folders are back opens right away (that is what the user was waiting for). */
  async function recheck(w: WorkspaceSummary) {
    setRowError((e) => ({ ...e, [w.id]: "" }));
    await probeWorkspaces([w.id]);
    const flagged = openError()?.id === w.id;
    const status = rowStatus(w, probeOf(w.id), false);
    if (flagged && !isDead(status)) await forceOpen(w.id);
  }

  async function confirmRemove(w: WorkspaceSummary) {
    setRemoving(null);
    try {
      await removeWorkspace(w.id);
      toast.success(t("ws.toast.removed", { name: w.name }));
      queueMicrotask(() => {
        const next = mains()[0];
        next?.focus();
      });
    } catch (e) {
      setRowError((r) => ({ ...r, [w.id]: workspaceErrorText(e) }));
    }
  }

  async function copyPath(w: WorkspaceSummary) {
    const p = w.repos[0]?.path;
    if (!p) return;
    try {
      await navigator.clipboard.writeText(p);
    } catch {
      /* no clipboard permission: nothing to report */
    }
  }

  async function duplicate(w: WorkspaceSummary) {
    const name = uniqueName(t("manage.copyName", { name: w.name }), workspaces().map((x) => x.name));
    try {
      const e = await duplicateWorkspace(w.id, name);
      toast.success(t("ws.toast.duplicated", { name: e.name }));
    } catch (e) {
      setRowError((r) => ({ ...r, [w.id]: workspaceErrorText(e) }));
    }
  }

  /** The first repo whose folder the last probe could not use: what Locate replaces. */
  const brokenRepo = (w: WorkspaceSummary) => w.repos.find((r) => probeOf(w.id)?.repos.some((p) => p.repoId === r.id && p.status !== "ok" && p.status !== "unresponsive"));

  function menuItems(w: WorkspaceSummary): MenuEntry[] {
    const missingRepo = brokenRepo(w);
    return [
      { label: t("welcome.recent.open"), onSelect: () => void activate(w) },
      { label: t("welcome.recent.reveal"), disabled: w.repos.length === 0, onSelect: () => void ipc.workspaces.reveal(w.id, w.repos[0].id).catch((e) => toast.error(workspaceErrorText(e))) },
      { label: t("welcome.recent.copyPath"), disabled: w.repos.length === 0, onSelect: () => void copyPath(w) },
      { type: "separator" },
      { label: t("welcome.recent.locate"), disabled: !missingRepo, onSelect: () => missingRepo && void locateFlow(w.id, missingRepo.id) },
      { label: t("welcome.recent.rename"), onSelect: () => setRenaming(w) },
      { label: t("welcome.recent.duplicate"), onSelect: () => void duplicate(w) },
      { type: "separator" },
      { label: t("welcome.recent.remove"), danger: true, onSelect: () => setRemoving(w.id) },
    ];
  }

  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    const onMain = target.classList.contains("recent__main");
    if (!onMain) return;
    const id = target.dataset.wsId!;
    const els = mains();
    const at = els.indexOf(target as HTMLButtonElement);
    const move = (to: number) => {
      e.preventDefault();
      const el = els[Math.max(0, Math.min(els.length - 1, to))];
      if (el) focusRow(el.dataset.wsId!);
    };
    if (e.key === "ArrowDown") return move(at + 1);
    if (e.key === "ArrowUp") return move(at - 1);
    if (e.key === "Home") return move(0);
    if (e.key === "End") return move(els.length - 1);
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      return setMenuFor(id);
    }
    if (e.key === "Delete" || (e.key === "Backspace" && !filter())) {
      e.preventDefault();
      return setRemoving(id);
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      return setFilter((f) => f.slice(0, -1));
    }
    if (e.key === "Escape" && filter()) {
      e.preventDefault();
      return setFilter("");
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey && e.key !== " ") {
      e.preventDefault();
      setFilter((f) => f + e.key);
      queueMicrotask(() => visible()[0] && focusRow(visible()[0].id));
    }
  }

  createEffect(
    on(removing, (id) => {
      if (id) queueMicrotask(() => list?.querySelector<HTMLButtonElement>(`[data-remove-confirm="${CSS.escape(id)}"]`)?.focus());
    }),
  );

  return (
    <div class="recent">
      <Show when={filter()}>
        <div class="recent__filter" role="status">
          <span class="recent__filter-text">{filter()}</span>
          <span class="recent__filter-count">{t("welcome.filterCount", { count: matches().length })}</span>
          <IconButton icon={X} label={t("manage.close")} size="sm" onClick={() => setFilter("")} class="recent__filter-clear" />
        </div>
      </Show>
      <Show
        when={visible().length > 0}
        fallback={
          <Show when={!props.hideEmpty || filter()}>
            <EmptyState size="sm" icon={FolderOpen} title={filter() ? t("welcome.filterCount", { count: 0 }) : t("welcome.recentEmpty")} />
          </Show>
        }
      >
        <ul class="recent__list" ref={list} role="list" onKeyDown={onKey}>
          <For each={visible()}>
            {(w) => {
              const status = () => effective(w);
              const badges = () => badgeSplit(w.repos);
              const branch = () => firstBranch(w);
              const reposText = () => t("welcome.recent.repos", { count: w.repos.length });
              const aria = () => t("welcome.recent.aria", { name: w.name, repos: reposText(), status: statusText(status()) || t("welcome.recent.open") });
              return (
                <li class="recent__item" data-dead={isDead(status()) ? "" : undefined} data-partial={status().kind === "someMissing" ? "" : undefined}>
                  <button
                    type="button"
                    class="recent__main"
                    data-ws-id={w.id}
                    tabindex={rovingId() === w.id ? 0 : -1}
                    aria-label={aria()}
                    onFocus={() => setFocused(w.id)}
                    onClick={() => void activate(w)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenuFor(w.id);
                    }}
                  >
                    <span class="recent__dot" style={{ "--wc": w.color }} aria-hidden="true" />
                    <span class="recent__body">
                      <span class="recent__head">
                        <span class="recent__name">{w.name}</span>
                        <Show when={status().kind !== "ok"}>
                          <span class="recent__status" data-kind={status().kind}>{statusText(status())}</span>
                        </Show>
                      </span>
                      <span class="recent__badges" aria-hidden="true">
                        <For each={badges().shown}>{(r) => <RepoBadge color={r.color} badge={r.badge} size={16} />}</For>
                        <Show when={badges().more > 0}>
                          <span class="recent__more">+{badges().more}</span>
                        </Show>
                      </span>
                      <Show when={w.repos[0]}>
                        {(r) => (
                          <span class="recent__path" dir="ltr">
                            <MiddleEllipsis text={shortPath(r().path)} />
                          </span>
                        )}
                      </Show>
                      <span class="recent__meta">
                        <Show when={branch()}>
                          {(b) => (
                            <>
                              <span class="recent__branch" dir="ltr">{t("welcome.recent.onBranch", { repo: b().repo, branch: b().branch })}</span>
                              <span aria-hidden="true"> · </span>
                            </>
                          )}
                        </Show>
                        {w.lastOpenedAt ? t("welcome.recent.opened", { when: fmt.relative(w.lastOpenedAt) }) : t("welcome.recent.neverOpened")}
                      </span>
                    </span>
                  </button>
                  <div class="recent__actions">
                    <Menu
                      aria-label={t("welcome.recent.more", { name: w.name })}
                      placement="bottom-end"
                      open={menuFor() === w.id}
                      onOpenChange={(o) => setMenuFor(o ? w.id : menuFor() === w.id ? null : menuFor())}
                      items={menuItems(w)}
                      trigger={(tp) => <IconButton {...tp} icon={Ellipsis} label={t("welcome.recent.more", { name: w.name })} size="sm" />}
                    />
                  </div>
                  <Show when={isDead(status()) || status().kind === "someMissing"}>
                    <div class="recent__fix">
                      <Show when={brokenRepo(w)}>
                        {(r) => <Button size="sm" variant="secondary" onClick={() => void locateFlow(w.id, r().id)}>{t("welcome.recent.locate")}</Button>}
                      </Show>
                      <Button size="sm" variant="ghost" onClick={() => setRemoving(w.id)}>{t("welcome.recent.remove")}</Button>
                      <Button size="sm" variant="ghost" onClick={() => void recheck(w)}>{t("welcome.recent.retry")}</Button>
                    </div>
                  </Show>
                  <Show when={rowError()[w.id]}>
                    <p class="recent__error" role="alert">{rowError()[w.id]}</p>
                  </Show>
                  <Show when={removing() === w.id}>
                    <div
                      class="recent__confirm"
                      role="group"
                      aria-label={t("welcome.recent.remove")}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          setRemoving(null);
                          focusRow(w.id);
                        }
                      }}
                    >
                      <span>{t("welcome.recent.removeConfirm", { name: w.name })}</span>
                      <Button size="sm" variant="danger" data-remove-confirm={w.id} onClick={() => void confirmRemove(w)}>{t("manage.removeConfirm")}</Button>
                      <Button size="sm" variant="ghost" onClick={() => batch(() => (setRemoving(null), focusRow(w.id)))}>{t("manage.cancel")}</Button>
                    </div>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
        <Show when={!filter() && matches().length > INITIAL}>
          <Button class="recent__toggle" size="sm" variant="ghost" onClick={() => setExpanded((e) => !e)}>
            {expanded() ? t("welcome.showLess") : t("welcome.showAll", { count: matches().length })}
          </Button>
        </Show>
      </Show>
      <RenameDialog target={renaming()} onClose={() => setRenaming(null)} />
    </div>
  );
}

function RenameDialog(props: { target: WorkspaceSummary | null; onClose: () => void }) {
  const [name, setName] = createSignal("");
  const [error, setError] = createSignal("");
  createEffect(on(() => props.target, (w) => (setName(w?.name ?? ""), setError(""))));
  async function save() {
    const w = props.target;
    if (!w) return;
    if (!name().trim()) return setError(t("manage.nameEmpty"));
    try {
      await renameWorkspace(w.id, name());
      toast.success(t("ws.toast.renamed", { name: name().trim() }));
      props.onClose();
    } catch (e) {
      setError(workspaceErrorText(e));
    }
  }
  return (
    <Dialog
      open={props.target !== null}
      onClose={props.onClose}
      title={t("manage.rename")}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>{t("manage.cancel")}</Button>
          <Button variant="primary" onClick={() => void save()}>{t("manage.save")}</Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label class="recent__rename-label">
          {t("manage.name")}
          <Input data-autofocus value={name()} invalid={!!error()} onInput={(e) => (setName(e.currentTarget.value), setError(""))} />
        </label>
        <Show when={error()}>
          <p class="recent__error" role="alert">{error()}</p>
        </Show>
      </form>
    </Dialog>
  );
}
