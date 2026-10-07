import { createVirtualizer } from "@tanstack/solid-virtual";
import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from "solid-js";
import { t } from "../../i18n";
import { activeTab } from "../../platform/tabs";
import { repos } from "../../store/workspace";
import {
  ChevronsDownUp, EmptyState, File, FileLock, FilePlus, Folder, FolderGit2, FolderOpen, FolderPlus, Icon, IconButton, Lock, Menu, RefreshCw, RepoBadge, ScrollArea, Spinner, StatusLetter, Tooltip, Tree, TreeRow,
  type MenuEntry,
} from "../../ui-kit";
import { copyPath, currentRepoId, newEntry, renameEntry, revealInFinder, trashEntry } from "./actions";
import { openFile } from "./buffers";
import { nodeKey, parentDir, type TreeNode } from "./logic";
import { collapseAll, cursorKey, decorationOf, isOpen, loadDir, refreshTree, scrollRequest, setCursorKey, setOpen, createTreeRows } from "./tree";
import "./editor.css";

const ROW = 22;

const newDirOf = (n: TreeNode) => (n.kind === "file" ? parentDir(n.path) : n.path);

function menuFor(node: TreeNode): MenuEntry[] {
  const { repoId, path } = node;
  const dir = newDirOf(node);
  const isRoot = node.kind === "root";
  return [
    ...(node.kind === "file" ? ([{ label: t("editor.menu.open"), onSelect: () => openFile(repoId, path) }, { type: "separator" }] as MenuEntry[]) : []),
    { label: t("editor.menu.newFile"), icon: FilePlus, onSelect: () => void newEntry(repoId, dir, "file") },
    { label: t("editor.menu.newFolder"), icon: FolderPlus, onSelect: () => void newEntry(repoId, dir, "dir") },
    ...(isRoot ? [] : ([{ type: "separator" }, { label: t("editor.menu.rename"), shortcut: ["F2"], onSelect: () => void renameEntry(repoId, path) }, { label: t("editor.menu.trash"), shortcut: ["⌘", "⌫"], danger: true, onSelect: () => void trashEntry(repoId, path, node.kind === "dir") }] as MenuEntry[])),
    { type: "separator" },
    { label: t("editor.menu.reveal"), onSelect: () => void revealInFinder(repoId, path) },
    { label: t("editor.menu.copyPath"), onSelect: () => void copyPath(repoId, path, true) },
    { label: t("editor.menu.copyRel"), onSelect: () => void copyPath(repoId, path, false) },
    ...(node.kind === "file" ? [] : ([{ type: "separator" }, { label: t("editor.menu.refresh"), icon: RefreshCw, onSelect: () => void loadDir(repoId, path, true) }] as MenuEntry[])),
  ];
}

interface MenuAt {
  x: number;
  y: number;
  node: TreeNode;
}

/** The menu opens at the pointer: a zero-size fixed anchor stands in for the trigger. */
function ContextMenu(props: { at: MenuAt | null; onClose: () => void }) {
  return (
    <Show when={props.at} keyed>
      {(at) => (
        <Menu
          open
          onOpenChange={(open) => !open && props.onClose()}
          items={menuFor(at.node)}
          aria-label={t("editor.menu.actionsFor", { name: at.node.name })}
          trigger={(p) => <span ref={p.ref} class="proj__anchor" style={{ left: `${at.x}px`, top: `${at.y}px` }} />}
        />
      )}
    </Show>
  );
}

function NoteRow(props: { node: TreeNode; start: number }) {
  return (
    <TreeRow compact depth={props.node.depth} class="proj-row proj-row--note" disabled style={{ position: "absolute", top: "0", left: "0", right: "0", height: `${ROW}px`, transform: `translateY(${props.start}px)` }} data-error={props.node.error ? "" : undefined} leading={props.node.loading ? <Spinner size={12} /> : undefined}>
      {props.node.name}
    </TreeRow>
  );
}

function Row(props: { node: TreeNode; index: number; start: number; selected: boolean; cursor: boolean; rowId: string; onPress: (n: TreeNode) => void; onMenu: (n: TreeNode, e: MouseEvent) => void }) {
  const n = () => props.node;
  const deco = createMemo(() => decorationOf(n()));
  const repo = () => repos().find((r) => r.id === n().repoId);
  const placed: JSX.CSSProperties = { position: "absolute", top: "0", left: "0", right: "0", height: `${ROW}px`, transform: `translateY(${props.start}px)` };
  const neverRead = () => !!n().entry?.neverRead;
  const ignored = () => !!n().entry?.ignored;
  return (
    <TreeRow
      id={props.rowId}
      compact
      depth={n().depth}
      style={placed}
      selected={props.selected}
      cursor={props.cursor}
      expanded={n().kind === "file" ? undefined : n().expanded}
      onToggle={() => setOpen(n().repoId, n().path, !n().expanded)}
      class="proj-row"
      data-kind={deco().kind}
      data-inside={deco().inside ? "" : undefined}
      data-dim={neverRead() || ignored() ? "" : undefined}
      data-root={n().kind === "root" ? "" : undefined}
      onClick={() => props.onPress(n())}
      onContextMenu={(e) => (e.preventDefault(), props.onMenu(n(), e))}
      leading={
        n().kind === "root" ? (
          <RepoBadge badge={repo()?.badge ?? "··"} color={repo()?.color ?? "var(--text-3)"} size={16} />
        ) : n().kind === "dir" ? (
          <Icon icon={n().expanded ? FolderOpen : Folder} size={14} />
        ) : neverRead() ? (
          <Icon icon={FileLock} size={14} />
        ) : (
          <Icon icon={File} size={14} />
        )
      }
      trailing={
        <>
          <Show when={neverRead()}>
            <Tooltip label={t("editor.proj.secretTip")}>
              <span class="proj-row__lock"><Icon icon={Lock} size={12} /></span>
            </Tooltip>
          </Show>
          <Show when={deco().kind && n().kind === "file"}>
            <StatusLetter kind={deco().kind!} />
          </Show>
          <Show when={n().kind !== "file" && (deco().inside || deco().kind)}>
            <span class="proj-row__dot" aria-label={t("editor.proj.changes")} role="img" />
          </Show>
        </>
      }
    >
      {n().name}
    </TreeRow>
  );
}

/** Multi-root file tree: one root per repo, lazy listings, git status colours, virtualised rows. */
export default function ProjectPanel() {
  const rows = createTreeRows();
  const [scrollEl, setScrollEl] = createSignal<HTMLElement | null>(null);
  const [menu, setMenu] = createSignal<MenuAt | null>(null);
  const [focused, setFocused] = createSignal(false);
  const treeId = "proj";

  const virt = createVirtualizer({
    get count() {
      return rows().length;
    },
    getScrollElement: () => scrollEl(),
    estimateSize: () => ROW,
    getItemKey: (i) => rows()[i]?.key ?? i,
    overscan: 12,
  });

  // Rows that are waiting for their listing start it.
  createEffect(() => {
    for (const r of rows()) if (r.loading) void loadDir(r.repoId, r.path);
  });

  const indexOfKey = (key: string | null) => (key === null ? -1 : rows().findIndex((r) => r.key === key));
  createEffect(
    on(scrollRequest, (req) => {
      if (!req) return;
      queueMicrotask(() => {
        const i = indexOfKey(req.key);
        if (i >= 0) virt.scrollToIndex(i, { align: "center" });
      });
    }),
  );

  const activeKey = createMemo(() => {
    const t = activeTab();
    return t?.type === "file" ? nodeKey(String(t.params?.repoId), String(t.params?.path)) : null;
  });

  const real = (n: TreeNode | undefined) => !!n && !n.loading && !n.error && !n.empty;
  const press = (n: TreeNode) => {
    if (!real(n)) return;
    setCursorKey(n.key);
    if (n.kind === "file") openFile(n.repoId, n.path);
    else setOpen(n.repoId, n.path, !isOpen(n.repoId, n.path));
  };
  const openMenu = (node: TreeNode, e: MouseEvent) => real(node) && (setCursorKey(node.key), setMenu({ x: e.clientX, y: e.clientY, node }));

  const cursorIndex = createMemo(() => indexOfKey(cursorKey()));
  const moveTo = (i: number) => {
    const list = rows();
    for (let j = i; j >= 0 && j < list.length; j += i >= cursorIndex() ? 1 : -1) {
      if (real(list[j])) {
        setCursorKey(list[j].key);
        virt.scrollToIndex(j, { align: "auto" });
        return;
      }
    }
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) {
      const n = rows()[cursorIndex()];
      if (e.metaKey && e.key === "Backspace" && real(n) && n.kind !== "root") (e.preventDefault(), void trashEntry(n.repoId, n.path, n.kind === "dir"));
      return;
    }
    const i = cursorIndex();
    const node = rows()[i];
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); return moveTo(Math.min(i + 1, rows().length - 1));
      case "ArrowUp": e.preventDefault(); return moveTo(Math.max(i - 1, 0));
      case "Home": e.preventDefault(); return moveTo(0);
      case "End": e.preventDefault(); return moveTo(rows().length - 1);
      case "ArrowRight":
        e.preventDefault();
        if (node?.kind !== "file" && real(node)) return node.expanded ? moveTo(i + 1) : setOpen(node.repoId, node.path, true);
        return;
      case "ArrowLeft": {
        e.preventDefault();
        if (!real(node)) return;
        if (node.kind !== "file" && node.expanded) return setOpen(node.repoId, node.path, false);
        const parent = node.depth > 0 ? rows().slice(0, i).reverse().find((r) => r.depth < node.depth && r.kind !== "file") : undefined;
        return parent && (setCursorKey(parent.key), virt.scrollToIndex(indexOfKey(parent.key), { align: "auto" }));
      }
      case "Enter":
      case " ":
        e.preventDefault();
        return node && press(node);
      case "F2":
        e.preventDefault();
        return void (real(node) && node.kind !== "root" && renameEntry(node.repoId, node.path));
      case "ContextMenu": {
        e.preventDefault();
        const el = document.getElementById(`${treeId}-${i}`)?.getBoundingClientRect();
        return void (node && el && openMenu(node, { clientX: el.left + 24, clientY: el.bottom } as MouseEvent));
      }
    }
  };

  const target = () => {
    const n = rows()[cursorIndex()];
    return n && real(n) ? { repoId: n.repoId, dir: newDirOf(n) } : { repoId: currentRepoId(), dir: "" };
  };

  return (
    <section class="proj" aria-label={t("editor.proj.title")}>
      <header class="proj__head">
        <span class="proj__title">{t("editor.proj.title")}</span>
        <span class="proj__actions">
          <IconButton icon={FilePlus} label={t("editor.proj.newFile")} size="sm" onClick={() => { const at = target(); at.repoId && void newEntry(at.repoId, at.dir, "file"); }} />
          <IconButton icon={RefreshCw} label={t("editor.proj.refresh")} size="sm" onClick={refreshTree} />
          <IconButton icon={ChevronsDownUp} label={t("editor.proj.collapse")} size="sm" onClick={collapseAll} />
        </span>
      </header>
      <Show when={repos().length > 0} fallback={<EmptyState icon={FolderGit2} size="sm" title={t("editor.proj.noRepos")} description={t("editor.proj.noReposDesc")} />}>
        <ScrollArea class="proj__scroll" ref={(el) => queueMicrotask(() => setScrollEl(el))}>
          <Tree
            class="proj__tree"
            aria-label={t("editor.proj.files")}
            tabIndex={0}
            aria-activedescendant={focused() && cursorIndex() >= 0 ? `${treeId}-${cursorIndex()}` : undefined}
            style={{ height: `${virt.getTotalSize() + 8}px`, position: "relative" }}
            onKeyDown={onKeyDown}
            onFocusIn={() => setFocused(true)}
            onFocusOut={() => setFocused(false)}
          >
            <For each={virt.getVirtualItems()}>
              {(item) => (
                <Show when={rows()[item.index]} keyed>
                  {(node) => node.loading || node.error || node.empty ? <NoteRow node={node} start={item.start} /> : <Row node={node} index={item.index} start={item.start} selected={activeKey() === node.key} cursor={focused() && cursorKey() === node.key} rowId={`${treeId}-${item.index}`} onPress={press} onMenu={openMenu} />}
                </Show>
              )}
            </For>
          </Tree>
        </ScrollArea>
      </Show>
      <ContextMenu at={menu()} onClose={() => setMenu(null)} />
    </section>
  );
}
