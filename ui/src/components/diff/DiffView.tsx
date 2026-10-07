import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { ipc, type DiffSource, type FileContents } from "../../ipc";
import { execute, getCommand } from "../../platform/commands";
import { selectedFile } from "../../store/selection";
import { repoError, snapshots } from "../../store/snapshots";
import { repos } from "../../store/workspace";
import { Badge, BrandMark, Button, Copy, CircleAlert, Eye, File, FileDiff, FolderOpen, IconButton, Kbd, ListChecks, SegmentedControl, ShieldAlert, Skeleton, TriangleAlert, StatusLetter, EmptyState, toast, readStored, resolvedTheme, writeStored } from "../../ui-kit";
import { splitPath } from "../push/logic";
import { t, type MessageKey } from "../../i18n";
import type { DiffHandle } from "./cm";
import "./diff.css";
import { classifyContents, languageKey, type DiffViewMode } from "./logic";

interface DiffTarget {
  repoId: string;
  path: string;
  origPath?: string | null;
}

export interface DiffViewProps {
  /** Defaults to the file selected in the Changes tree. */
  target?: DiffTarget;
  /** Fixed source (for example a commit); without it the header offers working tree and staged. */
  source?: DiffSource;
}

const VIEW_KEY = "intely.diff.view";

const SHORTCUTS: { label: MessageKey; keys: string[] }[] = [
  { label: "cmd.commit", keys: ["⌘", "↵"] },
  { label: "commit.commitPush", keys: ["⌥", "⌘", "↵"] },
  { label: "cmd.push", keys: ["⇧", "⌘", "K"] },
  { label: "cmd.toggleCommit", keys: ["⌘", "0"] },
  { label: "cmd.refreshAll", keys: ["⌘", "R"] },
];

function ShortcutList() {
  return (
    <dl class="diff-view__shortcuts" aria-label={t("diff.shortcuts")}>
      <For each={SHORTCUTS}>
        {(s) => (
          <div class="diff-view__shortcut">
            <dt>{t(s.label)}</dt>
            <dd>
              <Kbd keys={s.keys} />
            </dd>
          </div>
        )}
      </For>
    </dl>
  );
}

/** Below this width two panes of code are too narrow to read: the view falls back to unified. */
const SPLIT_MIN_WIDTH = 640;

const initialMode = (): DiffViewMode => (readStored(VIEW_KEY) === "split" ? "split" : "unified");
const formatBytes = (n?: number | null): string => (n == null ? "" : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

function DiffSkeleton() {
  return (
    <div class="diff-view__loading" aria-busy="true" aria-label={t("diff.loading")}>
      <For each={[38, 64, 52, 71, 45]}>{(w) => <Skeleton height={14} width={`${w}%`} />}</For>
    </div>
  );
}

/** Read-only diff of the selected file: CodeMirror 6 merge view, unified or side by side. */
export function DiffView(props: DiffViewProps) {
  const target = (): DiffTarget | null => props.target ?? selectedFile();
  const [preferred, setMode] = createSignal<DiffViewMode>(initialMode());
  const [bodyWidth, setBodyWidth] = createSignal(Infinity);
  const narrow = () => bodyWidth() < SPLIT_MIN_WIDTH;
  const mode = (): DiffViewMode => (narrow() ? "unified" : preferred());
  const [stage, setStage] = createSignal<"worktree" | "staged">("worktree");
  // Keyed by file: switching to another file hides secrets again before any request for it is made.
  const targetKey = () => `${target()?.repoId}:${target()?.path}`;
  const [revealedKey, setRevealedKey] = createSignal<string | null>(null);
  const revealed = () => revealedKey() === targetKey();
  const [stats, setStats] = createSignal<{ added: number; removed: number } | null>(null);

  const snapshot = () => snapshots()[target()?.repoId ?? ""];
  const change = createMemo(() => snapshot()?.changes.find((c) => c.path === target()?.path));
  const source = (): DiffSource => props.source ?? (stage() === "staged" ? { kind: "stagedVsHead" } : { kind: "worktreeVsHead" });
  const isDir = () => !!target()?.path.endsWith("/");

  // A new file starts on the working tree.
  createEffect(
    on(
      () => `${target()?.repoId}:${target()?.path}`,
      () => {
        setStage("worktree");
        setStats(null);
        setRevealedKey(null);
      },
      { defer: true },
    ),
  );

  const request = createMemo(() => {
    const t = target();
    if (!t || isDir()) return null;
    return { repoId: t.repoId, path: t.path, origPath: t.origPath ?? change()?.origPath ?? undefined, source: source(), reveal: revealed(), revision: snapshot()?.revision };
  });
  const [contents, { refetch }] = createResource(request, (r) => ipc.fileContents(r.repoId, r.path, r.origPath, r.source, r.reveal));
  // Keep showing the previous contents while a refresh is in flight, so a snapshot update does not flash a skeleton.
  // Snapshots refetch the file on every revision; identical contents must not rebuild the editor.
  const sameContents = (a?: FileContents, b?: FileContents) =>
    a === b || (!!a && !!b && a.path === b.path && a.original === b.original && a.modified === b.modified && a.binary === b.binary && a.tooLarge === b.tooLarge && a.guard === b.guard && a.language === b.language);
  // No request (file left the change list, folder selected): createResource keeps its last value, which must not stay on screen.
  const loaded = createMemo(() => (!request() || contents.error ? undefined : contents.latest), undefined, { equals: sameContents });
  const state = createMemo(() => {
    const c = loaded();
    return c ? classifyContents(c, revealed()) : null;
  });

  let host!: HTMLDivElement;
  let body!: HTMLDivElement;
  onMount(() => {
    const ro = new ResizeObserver(() => setBodyWidth(body.clientWidth || Infinity));
    ro.observe(body);
    onCleanup(() => ro.disconnect());
  });
  let handle: DiffHandle | undefined;
  let token = 0;
  const unmount = () => {
    token++;
    handle?.destroy();
    handle = undefined;
    host?.replaceChildren();
  };
  createEffect(
    on([loaded, state, mode], async ([c, s, m]) => {
      unmount();
      if (!c || s !== "diff") return setStats(null);
      const mine = token;
      const { mountDiff } = await import("./cm");
      if (mine !== token) return;
      const h = await mountDiff(host, m, { original: c.original, modified: c.modified, language: languageKey(c.path, c.language), dark: resolvedTheme() === "dark" });
      if (mine !== token) return h.destroy();
      handle = h;
      setStats(h.stats);
    }),
  );
  createEffect(on(resolvedTheme, (theme) => handle?.setDark(theme === "dark"), { defer: true }));
  onCleanup(unmount);

  const pathParts = () => splitPath(target()?.path ?? "");
  const origPath = () => props.target?.origPath ?? change()?.origPath;
  const canStage = () => !props.source && !!change() && (change()!.staged || change()!.partiallyStaged);
  const loading = () => contents.loading && !loaded();

  const placeholder = () => {
    if (!target()) {
      const known = repos().length > 0 && repos().every((r) => snapshots()[r.id] || repoError(r.id));
      // Nothing is claimed about the repos before they have all reported.
      if (!known) return <DiffSkeleton />;
      const dirty = Object.values(snapshots()).some((s) => s.changes.length > 0);
      return (
        <EmptyState
          class="diff-view__start"
          visual={<BrandMark size={72} variant="mark" />}
          title={dirty ? t("diff.selectFile") : t("diff.noChanges")}
          description={dirty ? t("diff.pickFile") : t("diff.clean")}
          action={<ShortcutList />}
        />
      );
    }
    if (isDir()) return <EmptyState icon={FolderOpen} title={t("diff.untrackedFolder")} description={t("diff.untrackedFolderDesc")} />;
    if (contents.error) {
      return <EmptyState tone="danger" icon={CircleAlert} title={t("diff.loadFailed")} description={(contents.error as { message?: string }).message} action={<Button onClick={() => void refetch()}>{t("comp.tryAgain")}</Button>} />;
    }
    // Also while the editor and its grammar load: a blank pane would look like a failure.
    if (loading() || state() === "diff") return <DiffSkeleton />;
    switch (state()) {
      case "secret":
        return (
          <EmptyState
            icon={ShieldAlert}
            title={t("diff.secretTitle")}
            description={t("diff.secretDesc")}
            action={
              <Button icon={Eye} onClick={() => setRevealedKey(targetKey())}>
                {t("diff.reveal")}
              </Button>
            }
          />
        );
      case "binary":
        return <EmptyState icon={File} title={t("diff.binary")} description={change()?.sizeBytes != null ? t("diff.binaryDescSize", { size: formatBytes(change()!.sizeBytes) }) : t("diff.binaryDesc")} />;
      case "tooLarge":
        return <EmptyState icon={File} title={t("diff.tooLarge")} description={t("diff.tooLargeDesc")} />;
      default:
        return <EmptyState icon={FileDiff} title={t("diff.noTextual")} description={t("diff.noTextualDesc")} />;
    }
  };

  return (
    <section class="diff-view" aria-label={t("diff.aria")}>
      <Show when={target() && !isDir()}>
        <header class="diff-view__head">
          <StatusLetter kind={change()?.kind ?? "modified"} />
          <div class="diff-view__title ui-truncate" title={target()?.path}>
            <span class="diff-view__name" classList={{ "ui-file-deleted": change()?.kind === "deleted" }}>
              {pathParts().name}
            </span>
            <Show when={pathParts().dir}>
              <span class="ui-path-hint">{pathParts().dir}</span>
            </Show>
            <Show when={origPath()}>
              <span class="diff-view__renamed ui-path-hint">{t("diff.renamedFrom", { name: origPath() ?? "" })}</span>
            </Show>
          </div>
          <IconButton
            icon={Copy}
            class="diff-view__copy"
            size="sm"
            label={t("diff.copyPath")}
            onClick={() => {
              navigator.clipboard?.writeText(target()?.path ?? "").then(
                () => toast.info(t("diff.pathCopied"), target()?.path),
                () => toast.error(t("diff.copyFailed")),
              );
            }}
          />
          <Show when={change()?.kind === "conflicted"}>
            <Badge tone="danger" size="sm" icon={TriangleAlert} title={t("changes.resolveConflict")}>
              {t("diff.conflict")}
            </Badge>
          </Show>
          <Show when={stats()}>
            {(s) => (
              <span class="diff-view__stats ui-tnum" aria-label={t("diff.stats", { added: s().added, removed: s().removed })}>
                <span class="diff-view__added">+{s().added}</span>
                <span class="diff-view__removed">−{s().removed}</span>
              </span>
            )}
          </Show>
          <Show when={!props.source && change()?.kind === "modified" && getCommand("graph.hunks")}>
            <IconButton icon={ListChecks} size="sm" label={t("diff.chooseHunks")} onClick={() => void execute("graph.hunks", { repoId: target()!.repoId, path: target()!.path })} />
          </Show>
          <Show when={canStage()}>
            <SegmentedControl
              size="sm"
              aria-label={t("diff.compare")}
              value={stage()}
              onChange={setStage}
              options={[
                { value: "worktree", label: t("diff.worktree") },
                { value: "staged", label: t("diff.staged") },
              ]}
            />
          </Show>
          <SegmentedControl
            size="sm"
            aria-label={t("diff.layout")}
            value={mode()}
            onChange={(v) => {
              setMode(v);
              writeStored(VIEW_KEY, v);
            }}
            options={[
              { value: "unified", label: t("diff.unified") },
              { value: "split", label: t("diff.split"), disabled: narrow(), tooltip: narrow() ? t("diff.noWidth") : undefined },
            ]}
          />
        </header>
      </Show>

      <div class="diff-view__body" ref={body}>
        <div class="diff-view__host" ref={host} hidden={!target() || state() !== "diff"} data-mode={mode()} />
        <Show when={state() !== "diff" || !stats()}>
          <div class="diff-view__placeholder">{placeholder()}</div>
        </Show>
      </div>
    </section>
  );
}
