import { createVirtualizer } from "@tanstack/solid-virtual";
import { createEffect, createMemo, createSignal, createUniqueId, For, on, Show } from "solid-js";
import { canSelect, checkedFiles, dirData, loadDir, selectedFile, setSelectedFile, toggleDir, toggleFile, toggleRepo, toggleUnversioned } from "../../store/selection";
import { clearPartial, isPartial } from "../../store/partialSelection";
import { refreshSnapshots, repoError, snapshots } from "../../store/snapshots";
import { loadWorkspace, messageMode, repos, workspaceError, workspaceState } from "../../store/workspace";
import { Button, CircleAlert, EmptyState, FolderGit2, ScrollArea, Skeleton, toast, Tree } from "../../ui-kit";
import { repoMessage } from "../commit/messageState";
import { t } from "../../i18n";
import { ChangeRow, stagedInProgress } from "./ChangeRow";
import { whenConnected } from "./whenConnected";
import { expandable, flattenTree, navigable, type TreeRow } from "./flatten";
import { treeKeyAction, type TreeKeyAction } from "./keyboard";
import {
  cursorKey, isDirExpanded, isRepoExpanded, isUnversionedExpanded, scrollRequest, setCursorKey, setDirExpanded, setRepoExpanded, setUnversionedExpanded,
} from "./treeState";
import "./changes.css";

const OVERSCAN = 12;

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && target.type !== "checkbox");
}

function TreeSkeleton() {
  return (
    <div class="chg-loading" aria-busy="true" aria-label={t("changes.loadingRepos")}>
      <For each={[0, 1, 2, 3]}>
        {(i) => (
          <div class="chg-loading__group">
            <div class="chg-loading__repo">
              <Skeleton width={14} height={14} />
              <Skeleton width={20} height={20} />
              <Skeleton width={`${44 - i * 5}%`} height={12} />
            </div>
            <For each={[0, 1, 2]}>
              {(j) => (
                <div class="chg-loading__file">
                  <Skeleton width={14} height={14} />
                  <Skeleton width={12} height={12} />
                  <Skeleton width={`${30 + ((i * 3 + j * 17) % 40)}%`} height={10} />
                </div>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}

/** The combined, virtualised Changes tree: repo groups with tri-state checkboxes, files, and per-repo Unversioned nodes. */
export function ChangesTree() {
  const treeId = createUniqueId();
  const [scrollEl, setScrollEl] = createSignal<HTMLDivElement>();
  const [focused, setFocused] = createSignal(false);
  // The cursor ring is a keyboard affordance: after a mouse press the selection tint is enough.
  const [keyboard, setKeyboard] = createSignal(false);
  let treeEl!: HTMLDivElement;
  let lastIndex = 0;

  // Only the ids are tracked, as one string: ticking a file in a repo that already has a field must not rebuild the rows.
  const withMessage = createMemo(() => (messageMode() === "perRepo" ? repos().filter((r) => checkedFiles(r.id).length > 0 || repoMessage(r.id).trim() !== "").map((r) => r.id).join("\n") : ""));
  const rows = createMemo(() =>
    flattenTree({
      repos: repos(),
      snapshot: (id) => snapshots()[id],
      repoError,
      repoExpanded: isRepoExpanded,
      unversionedExpanded: isUnversionedExpanded,
      dirExpanded: isDirExpanded,
      dirData,
      perRepoMessages: messageMode() === "perRepo",
      hasMessageField: (id) => withMessage().split("\n").includes(id),
    }),
  );
  const indexOfKey = (key: string | null) => (key === null ? -1 : rows().findIndex((r) => r.key === key));
  const cursorIndex = createMemo(() => indexOfKey(cursorKey()));

  const virt = createVirtualizer({
    get count() {
      return rows().length;
    },
    getScrollElement: () => scrollEl() ?? null,
    estimateSize: (i) => rows()[i]?.height ?? 22,
    getItemKey: (i) => rows()[i]?.key ?? i,
    overscan: OVERSCAN,
  });

  // Directories that were open last session list their files once the rows exist.
  createEffect(() => {
    for (const row of rows()) if (row.type === "dir" && row.expanded && !row.data) void loadDir(row.repoId, row.change.path);
  });

  // The cursor row can vanish (parent collapsed, file committed): fall back to the nearest row at the old position.
  createEffect(
    on(rows, (list) => {
      const key = cursorKey();
      if (key === null) return;
      if (list.some((r) => r.key === key)) return;
      const near = list.slice(0, lastIndex + 1).reverse().find(navigable);
      setCursorKey(near?.key ?? null);
    }),
  );
  createEffect(() => {
    const i = cursorIndex();
    if (i >= 0) lastIndex = i;
  });

  createEffect(
    on(scrollRequest, (req) => {
      if (!req) return;
      queueMicrotask(() => {
        const i = indexOfKey(req.key);
        if (i < 0) return;
        setCursorKey(req.key);
        virt.scrollToIndex(i, { align: "center" });
      });
    }),
  );

  const open = (row: TreeRow) => {
    if (row.type === "file" || row.type === "untracked") setSelectedFile(row.repoId, row.change.path);
  };
  const setOpen = (row: TreeRow, value: boolean) => {
    if (row.type === "repo") setRepoExpanded(row.repoId, value);
    else if (row.type === "unversioned") setUnversionedExpanded(row.repoId, value);
    else if (row.type === "dir") setDirExpanded(row.repoId, row.change.path, value);
  };
  const press = (row: TreeRow, index: number) => {
    setCursorKey(row.key);
    lastIndex = index;
    treeEl.focus({ preventScroll: true });
    if (expandable(row)) setOpen(row, !row.expanded);
    else open(row);
  };
  const toggleCheck = (row: TreeRow) => {
    if (row.type === "repo") toggleRepo(row.repoId);
    else if (row.type === "unversioned") void toggleUnversioned(row.repoId);
    else if (row.type === "dir") void toggleDir(row.repoId, row.change.path);
    else if (row.type === "file" || row.type === "untracked") {
      const name = row.change.path.split("/").pop();
      if (stagedInProgress(row.repoId, row.change)) toast.info(t("changes.staged", { name: name ?? "" }), t("changes.stagedDesc"));
      else if (canSelect(row.repoId, row.change.path)) (isPartial(row.repoId, row.change.path) ? clearPartial : toggleFile)(row.repoId, row.change.path);
      else toast.info(t("changes.notSelectable", { name: name ?? "" }), t("changes.notSelectableDesc"));
    }
  };
  const retry = (row: TreeRow): Promise<void> => (row.type === "note" && row.dir ? loadDir(row.repoId, row.dir) : refreshSnapshots(row.repoId));

  const apply = (action: TreeKeyAction) => {
    const list = rows();
    const row = list[action.index];
    switch (action.type) {
      case "move":
        setCursorKey(row.key);
        virt.scrollToIndex(action.index, { align: "auto" });
        break;
      case "expand":
        setOpen(row, true);
        break;
      case "collapse":
        setOpen(row, false);
        break;
      case "toggleCheck":
        toggleCheck(row);
        break;
      case "open":
        open(row);
        break;
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isEditable(e.target)) return;
    // Space/Enter on a row's action button belong to the button, not to the tree cursor.
    if (e.target instanceof Element && e.target.closest("button")) return;
    const action = treeKeyAction(rows(), cursorIndex(), e);
    if (!action) return;
    setKeyboard(true);
    e.preventDefault();
    apply(action);
  };

  const onFocusIn = (e: FocusEvent) => {
    setFocused(true);
    // Checkboxes live inside rows but the tree owns keyboard focus (aria-activedescendant).
    if (e.target instanceof HTMLInputElement && e.target.type === "checkbox") treeEl.focus({ preventScroll: true });
    if (e.target === treeEl && cursorIndex() < 0) {
      const sel = selectedFile();
      const start = (sel && rows().find((r) => (r.type === "file" || r.type === "untracked") && r.repoId === sel.repoId && r.change.path === sel.path)) ?? rows().find((r) => r.type === "repo");
      if (start) setCursorKey(start.key);
    }
  };
  const onFocusOut = (e: FocusEvent) => {
    if (!(e.relatedTarget instanceof Node) || !treeEl.contains(e.relatedTarget)) setFocused(false);
  };

  return (
    <div class="chg" data-testid="changes-tree">
      <Show when={workspaceState() !== "error"} fallback={<EmptyState tone="danger" icon={CircleAlert} title={t("changes.workspaceFailed")} description={workspaceError() ?? t("changes.engineSilent")} action={<Button variant="secondary" size="sm" onClick={() => void loadWorkspace()}>{t("changes.retry")}</Button>} />}>
        <Show when={workspaceState() === "ready"} fallback={<TreeSkeleton />}>
          <Show when={repos().length > 0} fallback={<EmptyState icon={FolderGit2} title={t("changes.noRepos")} description={t("changes.noReposDesc")} />}>
            <ScrollArea class="chg__scroll" ref={(el) => whenConnected(el, setScrollEl)}>
              <Tree
                ref={(el) => (treeEl = el)}
                class="chg__tree"
                aria-label={t("changes.tree")}
                multiselectable
                tabIndex={0}
                aria-activedescendant={cursorIndex() >= 0 ? `${treeId}-${cursorIndex()}` : undefined}
                style={{ height: `${virt.getTotalSize() + 8}px`, position: "relative" }}
                onKeyDown={onKeyDown}
                onPointerDown={() => setKeyboard(false)}
                onFocusIn={onFocusIn}
                onFocusOut={onFocusOut}
              >
                <For each={virt.getVirtualItems()}>
                  {(item) => (
                    <Show when={rows()[item.index]} keyed>
                      {(row) => (
                        <ChangeRow
                          row={row}
                          index={item.index}
                          start={item.start}
                          rowId={`${treeId}-${item.index}`}
                          cursor={focused() && keyboard() && cursorKey() === row.key}
                          onPress={press}
                          onToggleOpen={(r) => setOpen(r, !(r as Extract<TreeRow, { expanded: boolean }>).expanded)}
                          onRetry={retry}
                          measure={(el) => virt.measureElement(el)}
                        />
                      )}
                    </Show>
                  )}
                </For>
              </Tree>
            </ScrollArea>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
