import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import { changeBadgeSlots } from "../../platform/changeBadges";
import type { Change, GuardState, RepoSnapshot } from "../../ipc";
import { draftingRepo, draftRepoMessage, generateRepoTooltip } from "../commit/generate";
import { RepoMessageField } from "../commit/RepoMessageField";
import { commitRepo, fetchRepo, pullRepo, pushRepo } from "../../store/actions";
import { canSelect, checkedCount, dirData, dirTick, fileChecked, repoTick, selectedFile, toggleDir, toggleFile, toggleRepo, toggleUnversioned, unversionedBusy, unversionedTick, type Tick } from "../../store/selection";
import { clearPartial, isPartial } from "../../store/partialSelection";
import { snapshots } from "../../store/snapshots";
import { touchedByAgent } from "../../store/touched";
import { repoBusy, repoConfig } from "../../store/workspace";
import {
  AheadBehind, Archive, ArrowDownToLine, Badge, BranchPill, Button, Checkbox, CircleAlert, CloudDownload, FileQuestionMark, Folder, GitCommitHorizontal, GitFork, GitMerge, Icon, IconButton, Info,
  Lock, RepoBadge, Skeleton, Spinner, Sparkles, StatusLetter, Tooltip, TreeRow, TriangleAlert, Upload, ariaChecked, type CheckState,
} from "../../ui-kit";
import type { TreeRow as Row } from "./flatten";
import { t, type MessageKey } from "../../i18n";

export const tickState = (tick: Tick): CheckState => (tick === "checked" ? true : tick === "mixed" ? "mixed" : false);

const nameOf = (path: string) => path.replace(/\/$/, "").slice(path.replace(/\/$/, "").lastIndexOf("/") + 1);
const parentOf = (path: string) => {
  const p = path.replace(/\/$/, "");
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
};

const GUARD_REASON = {
  neverAdd: "changes.guard.neverAdd",
  secret: "changes.guard.secret",
  tooLarge: "changes.guard.tooLarge",
} as const satisfies Record<Exclude<GuardState, "ok" | "sensitive">, MessageKey>;

/** Why a row cannot be ticked, if it cannot. */
function lockReason(change: Change): string | undefined {
  if (change.guard !== "ok" && change.guard !== "sensitive") return t(GUARD_REASON[change.guard]);
  if (change.kind === "conflicted") return t("changes.resolveConflict");
  return undefined;
}

/** During a merge, rebase, cherry-pick or revert the whole staged index is committed, so a staged file cannot be left out. */
export function stagedInProgress(repoId: string, change: Change): boolean {
  const state = snapshots()[repoId]?.state;
  return change.staged && state !== undefined && state !== "normal" && state !== "bisecting";
}

const STATE_TEXT = {
  merging: "changes.state.merging",
  rebasing: "changes.state.rebasing",
  cherryPicking: "changes.state.cherryPicking",
  reverting: "changes.state.reverting",
  bisecting: "changes.state.bisecting",
} as const satisfies Record<string, MessageKey>;

export interface ChangeRowProps {
  row: Row;
  index: number;
  /** Pixel offset from the top of the list. */
  start: number;
  cursor: boolean;
  rowId: string;
  onPress: (row: Row, index: number) => void;
  onToggleOpen: (row: Row) => void;
  onRetry: (row: Row) => void | Promise<void>;
  measure?: (el: HTMLElement) => void;
}

/** Absolute positioning inside the virtual list. Kept inline: these values change on every scroll. */
const place = (start: number, height: number | "auto", depth?: number): JSX.CSSProperties => ({
  position: "absolute",
  top: "0",
  left: "0",
  right: "0",
  height: height === "auto" ? "auto" : `${height}px`,
  transform: `translateY(${start}px)`,
  // TreeRow sets its own --depth; the plain rows below need it for their indent.
  ...(depth === undefined ? {} : { "--depth": depth }),
});

const SENSITIVE_REASON = () => t("changes.sensitiveReason");

function GuardIcon(props: { reason: string; conflict?: boolean; sensitive?: boolean }) {
  const label = () => (props.conflict ? t("changes.guardLabel.conflict") : props.sensitive ? t("changes.guardLabel.sensitive") : t("changes.guardLabel.guarded"));
  return (
    <Tooltip label={props.reason}>
      <span class="chg-lock" role="img" aria-label={t("changes.guardAria", { label: label(), reason: props.reason })} data-conflict={props.conflict ? "" : undefined} data-sensitive={props.sensitive ? "" : undefined}>
        <Icon icon={props.conflict ? TriangleAlert : Lock} size={12} />
      </span>
    </Tooltip>
  );
}

/** A small dot on files an agent run changed, until the user has reviewed them. */
function AgentDot(props: { repoId: string; path: string }) {
  return (
    <Show when={touchedByAgent(props.repoId, props.path)}>
      {(touch) => (
        <Tooltip label={t(touch().active ? "changes.agentBeing" : "changes.agentChanged", { role: touch().role })}>
          <span class="chg-agent" role="img" aria-label={t(touch().active ? "changes.agentBeing" : "changes.agentChanged", { role: touch().role })} data-active={touch().active ? "" : undefined} />
        </Tooltip>
      )}
    </Show>
  );
}

function FileLikeRow(props: ChangeRowProps & { change: Change; hint: string }) {
  const lock = () => lockReason(props.change);
  const selected = () => {
    const s = selectedFile();
    return s?.repoId === props.row.repoId && s.path === props.change.path;
  };
  // A file with only some hunks chosen (Hunks tab) reads as mixed; ticking it again takes the whole file.
  const state = createMemo<CheckState>(() => (isPartial(props.row.repoId, props.change.path) && fileChecked(props.row.repoId, props.change.path) ? "mixed" : fileChecked(props.row.repoId, props.change.path)));
  const renamedFrom = () => (props.change.origPath ? t("changes.renamedFrom", { name: nameOf(props.change.origPath) }) : "");
  return (
    <TreeRow
      id={props.rowId}
      data-row="file"
      data-repo={props.row.repoId}
      data-path={props.change.path}
      compact
      depth={props.row.depth}
      selected={selected()}
      cursor={props.cursor}
      disabled={!!lock()}
      aria-checked={ariaChecked(state())}
      aria-description={lock() ?? (props.change.guard === "sensitive" ? SENSITIVE_REASON() : undefined)}
      style={place(props.start, props.row.height)}
      onClick={() => props.onPress(props.row, props.index)}
      leading={
        <>
          <Checkbox
            size="sm"
            tabIndex={-1}
            aria-label={lock() ? t("changes.cannotCommit", { name: nameOf(props.change.path), reason: lock()! }) : t("changes.include", { name: nameOf(props.change.path) })}
            disabled={!!lock() || !canSelect(props.row.repoId, props.change.path) || stagedInProgress(props.row.repoId, props.change)}
            checked={state()}
            onChange={() => (isPartial(props.row.repoId, props.change.path) ? clearPartial(props.row.repoId, props.change.path) : toggleFile(props.row.repoId, props.change.path))}
          />
          <StatusLetter kind={props.change.kind} />
        </>
      }
      trailing={
        <Show when={lock()} fallback={<Show when={props.change.guard === "sensitive"}><GuardIcon reason={SENSITIVE_REASON()} sensitive /></Show>}>
          {(reason) => <GuardIcon reason={reason()} conflict={props.change.kind === "conflicted"} />}
        </Show>
      }
    >
      <span classList={{ "ui-file-deleted": props.change.kind === "deleted" }} title={props.change.path}>
        {nameOf(props.change.path)}
      </span>
      <AgentDot repoId={props.row.repoId} path={props.change.path} />
      <For each={changeBadgeSlots()}>{(slot) => <Dynamic component={slot.component} repoId={props.row.repoId} path={props.change.path} />}</For>
      <Show when={props.hint || renamedFrom()}>
        <span class="ui-path-hint">{[props.hint, renamedFrom()].filter(Boolean).join("  ·  ")}</span>
      </Show>
    </TreeRow>
  );
}

function RepoRow(props: ChangeRowProps & { row: Extract<Row, { type: "repo" }> }) {
  const config = () => props.row.config;
  const snapshot = (): RepoSnapshot | undefined => props.row.snapshot;
  const tick = createMemo(() => repoTick(config().id));
  const picked = () => checkedCount(config().id);
  const busy = () => repoBusy(config().id);
  const unavailable = (kind: string) => (busy() ? t("changes.busyOp", { name: config().name, op: busy()! }) : kind);
  return (
    <TreeRow
      id={props.rowId}
      data-row="repo"
      data-repo={config().id}
      depth={0}
      class="chg-row chg-row--repo"
      expanded={props.row.expanded}
      cursor={props.cursor}
      aria-checked={ariaChecked(tickState(tick()))}
      style={place(props.start, props.row.height)}
      onToggle={() => props.onToggleOpen(props.row)}
      onClick={() => props.onPress(props.row, props.index)}
      leading={
        <>
          <Checkbox
            size="sm"
            tabIndex={-1}
            aria-label={t("changes.selectAllIn", { name: config().name })}
            disabled={!snapshot()}
            checked={tickState(tick())}
            onChange={() => toggleRepo(config().id)}
          />
          <RepoBadge color={config().color} badge={config().badge} size={20} />
        </>
      }
      trailing={
        <Show when={snapshot()} fallback={<Skeleton width={72} height={14} />}>
          {(snap) => (
            <>
              <Show when={busy()}>
                <Spinner size={12} label={t("changes.opRunning", { op: busy()! })} />
              </Show>
              <Show when={snap().state !== "normal"}>
                <Badge tone="warn" size="sm" icon={GitMerge} title={t(STATE_TEXT[snap().state as keyof typeof STATE_TEXT])}>
                  {snap().state === "merging" ? t("changes.badge.merging") : snap().state === "rebasing" ? t("changes.badge.rebasing") : t("changes.badge.busy")}
                </Badge>
              </Show>
              <BranchPill name={snap().head.branch ?? undefined} detached={snap().head.detached} unborn={snap().head.unborn} oid={snap().head.oid?.slice(0, 7)} upstream={snap().upstream ? `${snap().upstream!.remote}/${snap().upstream!.branch}` : undefined} />
              <AheadBehind ahead={snap().ahead} behind={snap().behind} />
              <Show when={snap().stashCount > 0}>
                <Badge class="chg-meta" size="sm" icon={Archive} numeric title={t("changes.stashCount", { n: snap().stashCount })}>
                  {snap().stashCount}
                </Badge>
              </Show>
              <Show when={snap().worktreeCount > 0}>
                <Badge class="chg-meta" size="sm" icon={GitFork} numeric title={t("changes.worktreeCount", { n: snap().worktreeCount })}>
                  {snap().worktreeCount}
                </Badge>
              </Show>
            </>
          )}
        </Show>
      }
      actions={
        <span class="chg-actions" onClick={(e) => e.stopPropagation()}>
          <IconButton size="sm" icon={Sparkles} tabIndex={props.cursor ? 0 : -1} label={t("changes.generateRepo", { name: config().name })} tooltip={picked() === 0 ? t("changes.generateNothing") : generateRepoTooltip(config().name)} loading={draftingRepo(config().id)} disabled={picked() === 0 || !!busy()} onClick={() => void draftRepoMessage(config().id)} />
          <IconButton size="sm" icon={GitCommitHorizontal} tabIndex={props.cursor ? 0 : -1} label={t("changes.commitRepo", { name: config().name })} tooltip={picked() === 0 ? t("changes.commitNothing") : t("changes.commitFiles", { n: picked(), name: config().name })} disabled={picked() === 0 || !!busy()} onClick={() => void commitRepo(config().id)} />
          <IconButton size="sm" icon={Upload} tabIndex={props.cursor ? 0 : -1} label={t("changes.pushRepo", { name: config().name })} tooltip={unavailable(t("changes.pushRepoTip", { name: config().name }))} disabled={!!busy()} onClick={() => void pushRepo(config().id)} />
          <IconButton size="sm" icon={ArrowDownToLine} tabIndex={props.cursor ? 0 : -1} label={t("changes.pullRepo", { name: config().name })} tooltip={unavailable(t("changes.pullRepoTip", { name: config().name }))} disabled={!!busy()} onClick={() => void pullRepo(config().id)} />
          <IconButton size="sm" icon={CloudDownload} tabIndex={props.cursor ? 0 : -1} label={t("changes.fetchRepo", { name: config().name })} tooltip={unavailable(t("changes.fetchRepo", { name: config().name }))} disabled={!!busy()} onClick={() => void fetchRepo(config().id)} />
        </span>
      }
    >
      <span class="chg-repo-name">{config().name}</span>
      <Show when={snapshot()?.error ? undefined : snapshot() && snapshot()!.changes.length > 0 ? snapshot() : undefined}>
        {(snap) => (
          <span class="chg-count ui-tnum" title={t("changes.changedEntries", { n: snap().changes.length })}>
            {snap().changes.length.toLocaleString("en-US")}
          </span>
        )}
      </Show>
    </TreeRow>
  );
}

function UnversionedRow(props: ChangeRowProps & { row: Extract<Row, { type: "unversioned" }> }) {
  const tick = createMemo(() => unversionedTick(props.row.repoId));
  const files = () => props.row.entries - props.row.folders;
  const title = () => (props.row.folders ? t("changes.untrackedFilesFolders", { files: files(), folders: props.row.folders }) : t("changes.untrackedFiles", { files: files() }));
  return (
    <TreeRow
      id={props.rowId}
      data-row="unversioned"
      data-repo={props.row.repoId}
      compact
      depth={1}
      expanded={props.row.expanded}
      cursor={props.cursor}
      aria-checked={ariaChecked(tickState(tick()))}
      style={place(props.start, props.row.height)}
      onToggle={() => props.onToggleOpen(props.row)}
      onClick={() => props.onPress(props.row, props.index)}
      leading={
        <>
          <Checkbox size="sm" tabIndex={-1} aria-label={t("changes.selectAllUnversioned")} checked={tickState(tick())} onChange={() => void toggleUnversioned(props.row.repoId)} />
          <Icon icon={FileQuestionMark} size={14} class="chg-kind-icon" />
        </>
      }
      trailing={
        <>
          <Show when={unversionedBusy(props.row.repoId)}>
            <Spinner size={12} label={t("changes.listingFiles")} />
          </Show>
          <Badge size="sm" numeric title={title()}>
            {props.row.entries.toLocaleString("en-US")}
          </Badge>
        </>
      }
    >
      <span class="ui-text-2">{t("changes.unversioned")}</span>
    </TreeRow>
  );
}

function DirRow(props: ChangeRowProps & { row: Extract<Row, { type: "dir" }> }) {
  const tick = createMemo(() => dirTick(props.row.repoId, props.row.change.path));
  const lock = () => lockReason(props.row.change);
  const data = () => dirData(props.row.repoId, props.row.change.path);
  return (
    <TreeRow
      id={props.rowId}
      data-row="dir"
      data-repo={props.row.repoId}
      data-path={props.row.change.path}
      compact
      depth={2}
      expanded={props.row.expanded}
      cursor={props.cursor}
      disabled={!!lock()}
      aria-checked={ariaChecked(tickState(tick()))}
      aria-description={lock()}
      style={place(props.start, props.row.height)}
      onToggle={() => props.onToggleOpen(props.row)}
      onClick={() => props.onPress(props.row, props.index)}
      leading={
        <>
          <Checkbox size="sm" tabIndex={-1} aria-label={t("changes.selectAllFilesIn", { name: nameOf(props.row.change.path) })} disabled={!!lock()} checked={tickState(tick())} onChange={() => void toggleDir(props.row.repoId, props.row.change.path)} />
          <Icon icon={Folder} size={14} class="chg-kind-icon" />
        </>
      }
      trailing={
        <>
          <Show when={data()?.status === "loading"}>
            <Spinner size={12} label={t("changes.listingFiles")} />
          </Show>
          <Show when={data()?.status === "loaded"}>
            <Badge size="sm" numeric>
              {data()!.files.length.toLocaleString("en-US")}
              {data()!.truncated ? "+" : ""}
            </Badge>
          </Show>
          <Show when={lock()}>{(reason) => <GuardIcon reason={reason()} />}</Show>
        </>
      }
    >
      <span title={props.row.change.path}>{nameOf(props.row.change.path)}</span>
      <Show when={parentOf(props.row.change.path)}>
        <span class="ui-path-hint">{parentOf(props.row.change.path)}</span>
      </Show>
    </TreeRow>
  );
}

function NoteRow(props: ChangeRowProps & { row: Extract<Row, { type: "note" }> }) {
  const [retrying, setRetrying] = createSignal(false);
  const icon = () => (props.row.tone === "error" || props.row.tone === "dirError" ? CircleAlert : props.row.tone === "truncated" ? TriangleAlert : Info);
  return (
    <div
      id={props.rowId}
      role="treeitem"
      aria-level={props.row.depth + 1}
      class="chg-note"
      data-tone={props.row.tone}
      title={props.row.text}
      style={place(props.start, props.row.height, props.row.depth)}
    >
      <Icon icon={icon()} size={12} />
      <span class="chg-note__text">{props.row.text}</span>
      <Show when={props.row.tone === "error" || props.row.tone === "dirError"}>
        <Button
          size="sm"
          variant="ghost"
          loading={retrying()}
          onClick={async () => {
            setRetrying(true);
            // Long enough to be seen even when the same error comes straight back.
            await Promise.all([props.onRetry(props.row), new Promise((r) => setTimeout(r, 500))]).catch(() => undefined);
            setRetrying(false);
          }}
        >
          {t("changes.retry")}
        </Button>
      </Show>
    </div>
  );
}

function BannerRow(props: ChangeRowProps & { row: Extract<Row, { type: "banner" }> }) {
  return (
    <div id={props.rowId} role="treeitem" aria-level={props.row.depth + 1} aria-disabled="true" class="chg-banner" style={place(props.start, props.row.height)}>
      <div class="chg-banner__box" title={t("changes.bannerTitle")}>
        <Icon icon={GitMerge} size={14} />
        <span class="ui-truncate">
          <strong>{t(STATE_TEXT[props.row.state as keyof typeof STATE_TEXT])}.</strong> {t("changes.bannerRest")}
        </span>
      </div>
    </div>
  );
}

function SkeletonRow(props: ChangeRowProps & { row: Extract<Row, { type: "skeleton" }> }) {
  const widths = [58, 42, 66];
  return (
    <div id={props.rowId} role="treeitem" aria-level={props.row.depth + 1} aria-busy="true" aria-disabled="true" aria-label={t("changes.loading")} class="chg-skeleton" style={place(props.start, props.row.height, props.row.depth)}>
      <Skeleton width={14} height={14} />
      <Skeleton width={12} height={12} />
      <Skeleton width={`${widths[props.row.index % widths.length]}%`} height={10} />
    </div>
  );
}

/**
 * One row of the virtual list. The row object is fixed for the lifetime of the component (the list re-creates the
 * component when the structure changes); everything that changes while ticking is read from the stores inside.
 */
export function ChangeRow(props: ChangeRowProps) {
  const row = props.row;
  switch (row.type) {
    case "repo":
      return <RepoRow {...props} row={row} />;
    case "file":
      return <FileLikeRow {...props} change={row.change} hint={parentOf(row.change.path)} />;
    case "untracked":
      // Below a folder row the folder's own path is redundant: only the part inside it is a useful hint.
      return <FileLikeRow {...props} change={row.change} hint={parentOf(row.dir ? row.change.path.slice(row.dir.length) : row.change.path)} />;
    case "unversioned":
      return <UnversionedRow {...props} row={row} />;
    case "dir":
      return <DirRow {...props} row={row} />;
    case "note":
      return <NoteRow {...props} row={row} />;
    case "banner":
      return <BannerRow {...props} row={row} />;
    case "skeleton":
      return <SkeletonRow {...props} row={row} />;
    case "message":
      return (
        <div
          id={props.rowId}
          ref={(el) => {
            // The virtualizer reads data-index when it starts observing; Solid applies attributes after refs.
            el.setAttribute("data-index", String(props.index));
            props.measure?.(el);
          }}
          data-index={props.index}
          role="treeitem"
          aria-level={row.depth + 1}
          aria-label={t("changes.messageFor", { name: repoConfig(row.repoId)?.name ?? row.repoId })}
          class="chg-message"
          // Height follows the field; `row.height` is only the estimate until it is measured.
          style={place(props.start, "auto", row.depth)}
        >
          <RepoMessageField repoId={row.repoId} />
        </div>
      );
  }
}
