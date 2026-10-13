import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { DiffView } from "../../../components/diff/DiffView";
import { t } from "../../../i18n";
import { ipc } from "../../../ipc";
import type { Change } from "../../../ipc";
import type { ServerChanges } from "../../../ipc/servers";
import { repoConfig, repos } from "../../../store/workspace";
import { Badge, Button, ChevronDown, ChevronRight, Dialog, Download, GitBranch, Icon, IconButton, Lock, Plus, RefreshCw, Select, Server, Skeleton, StatusLetter, Upload, X } from "../../../ui-kit";
import { splitPath } from "../../../components/push/logic";
import { enabledServers, ensureServers, serverName } from "../store";
import { transferMessage, TransferDialog, type TransferTarget } from "./TransferDialog";
import { clock, keyOf, pinnedViews, pinView, refreshView, setViewOpen, shownViews, startPolling, unpinView, viewEntry, viewOpen, type ViewKey } from "./serverView";
import "./serverview.css";

interface OpenFile {
  key: ViewKey;
  change: Change;
}

const repoName = (repoId: string): string => repoConfig(repoId)?.name ?? repoId;

/** What a group says when it has no file list to show. */
function stateText(data: ServerChanges): string | undefined {
  switch (data.state) {
    case "missing":
      return t("serverview.missing");
    case "notGit":
      return t("serverview.notGit");
    case "error":
      return data.error ? `${t("serverview.readFailed")}: ${data.error}` : t("serverview.readFailed");
    default:
      return undefined;
  }
}

function FileRow(props: { change: Change; onOpen: () => void }) {
  const parts = () => splitPath(props.change.path);
  return (
    <li>
      <button type="button" class="sv-file" title={props.change.path} aria-label={t("serverview.openFile", { name: parts().name })} onClick={props.onOpen}>
        <StatusLetter kind={props.change.kind} />
        <span class="sv-file__name ui-truncate" classList={{ "ui-file-deleted": props.change.kind === "deleted" }}>{parts().name}</span>
        <Show when={parts().dir}>
          <span class="sv-file__dir ui-path-hint ui-truncate">{parts().dir}</span>
        </Show>
      </button>
    </li>
  );
}

/** One repository on one server: a read-only list of its uncommitted changes. There is no stage, commit, discard or stash here. */
function Group(props: { view: ViewKey; active: boolean; pinned: boolean; onOpenFile: (f: OpenFile) => void; onTransfer: (t: TransferTarget) => void }) {
  const entry = () => viewEntry(props.view);
  const data = () => entry()?.data;
  const sName = () => serverName(props.view.serverId) ?? props.view.serverId;
  const rName = () => repoName(props.view.repoId);
  const transfer = (direction: "bring" | "send") => props.onTransfer({ ...props.view, direction, serverName: sName(), repoName: rName() });
  const message = () => {
    const e = entry()?.error;
    return e ?? "";
  };

  return (
    <section class="sv-group" aria-label={t("serverview.badgeTitle", { name: sName() })} data-active={props.active ? "" : undefined}>
      <header class="sv-group__head">
        <Icon icon={Server} size={14} class="sv-group__icon" />
        <span class="sv-group__repo ui-truncate" title={rName()}>{rName()}</span>
        <Badge tone="info" size="sm" icon={Server} title={t("serverview.badgeTitle", { name: sName() })}>{t("serverview.badge", { name: sName() })}</Badge>
        <Show when={data()?.branch}>
          {(b) => <Badge size="sm" icon={GitBranch}>{b()}</Badge>}
        </Show>
        <Show when={props.active}>
          <span class="sv-group__live" aria-hidden="true" />
        </Show>
        <span class="sv-group__grow" />
        <Show when={data()}>
          {(d) => (
            <time class="sv-group__time ui-tnum" dateTime={new Date(d().updatedAtMs).toISOString()}>{t("serverview.updated", { time: clock(d().updatedAtMs) })}</time>
          )}
        </Show>
        <IconButton icon={RefreshCw} size="sm" label={t("serverview.refresh")} loading={entry()?.loading} onClick={() => void refreshView(props.view)} />
        <Show when={data()?.state === "ok"}>
          <IconButton icon={Download} size="sm" label={t("serverview.bring")} tooltip={t("serverview.bringTip")} onClick={() => transfer("bring")} />
          <IconButton icon={Upload} size="sm" label={t("serverview.send")} tooltip={props.active ? transferMessage("runActive", "") : t("serverview.sendTip")} disabled={props.active} onClick={() => transfer("send")} />
        </Show>
        <Show when={props.pinned}>
          <IconButton icon={X} size="sm" label={t("serverview.hide")} onClick={() => unpinView(props.view)} />
        </Show>
      </header>

      <Show when={data()?.state === "ok"}>
        <p class="sv-group__hint" title={t("serverview.readOnly")}>
          <Icon icon={Lock} size={12} /> {t("serverview.hint")}
        </p>
      </Show>

      <Show
        when={data()}
        fallback={
          <Show
            when={entry()?.error}
            fallback={
              <div class="sv-group__loading" aria-busy="true" aria-label={t("serverview.notRead")}>
                <Skeleton height={12} width="55%" />
                <Skeleton height={12} width="35%" />
              </div>
            }
          >
            <div class="sv-state" data-tone="error" role="alert">
              <p>{t("serverview.unreachable")}</p>
              <p class="sv-state__detail">{message()}</p>
              <Button size="sm" variant="secondary" onClick={() => void refreshView(props.view)}>{t("serverview.retry")}</Button>
            </div>
          </Show>
        }
      >
        {(d) => (
          <>
            <Show when={entry()?.error}>
              <p class="sv-state" data-tone="warn" role="status">{t("serverview.unreachable")}: {message()}</p>
            </Show>
            <Show
              when={d().state === "ok"}
              fallback={
                <p class="sv-state" data-tone="warn" role="status">
                  {stateText(d())}
                </p>
              }
            >
              <Show when={d().changes.length > 0} fallback={<p class="sv-state" role="status">{t("serverview.clean")}</p>}>
                <p class="sv-group__count ui-tnum">{t("serverview.files", { n: d().total })}</p>
                <ul class="sv-files" aria-label={t("serverview.badge", { name: sName() })}>
                  <For each={d().changes}>{(c) => <FileRow change={c} onOpen={() => props.onOpenFile({ key: props.view, change: c })} />}</For>
                </ul>
                <Show when={d().truncated}>
                  <p class="sv-group__more">{t("serverview.shown", { shown: d().changes.length, total: d().total })}</p>
                </Show>
              </Show>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}

/** The diff of one file of the server's working copy, in the existing diff viewer. */
function FileDialog(props: { file: OpenFile | undefined; onClose: () => void }) {
  const target = () => {
    const f = props.file;
    return f ? { repoId: `server:${keyOf(f.key)}`, path: f.change.path, origPath: f.change.origPath ?? undefined } : undefined;
  };
  return (
    <Dialog
      open={!!props.file}
      onClose={props.onClose}
      size="xl"
      title={t("serverview.diff.title", { name: props.file ? splitPath(props.file.change.path).name : "", server: props.file ? (serverName(props.file.key.serverId) ?? props.file.key.serverId) : "" })}
      description={t("serverview.hint")}
    >
      <Show when={props.file} keyed>
        {(f) => (
          <div class="sv-diff">
            <DiffView
              target={target()}
              kind={f.change.kind}
              load={(reveal) => ipc.servers.file(f.key.serverId, f.key.repoId, f.change.path, f.change.origPath ?? undefined, f.change.kind === "untracked", reveal)}
            />
          </div>
        )}
      </Show>
    </Dialog>
  );
}

function AddView() {
  const [server, setServer] = createSignal<string | undefined>(undefined);
  const [repo, setRepo] = createSignal<string | undefined>(undefined);
  const show = () => {
    const s = server();
    const r = repo();
    if (!s || !r) return;
    const k = { serverId: s, repoId: r };
    pinView(k);
    void refreshView(k);
  };
  return (
    <div class="sv-add" role="group" aria-label={t("serverview.add.label")}>
      <Select size="sm" aria-label={t("serverview.add.server")} placeholder={t("serverview.add.server")} value={server()} onChange={setServer} options={enabledServers().map((s) => ({ value: s.cfg.id, label: s.cfg.name }))} />
      <Select size="sm" aria-label={t("serverview.add.repo")} placeholder={t("serverview.add.repo")} value={repo()} onChange={setRepo} options={repos().map((r) => ({ value: r.id, label: r.name }))} />
      <IconButton icon={Plus} size="sm" variant="secondary" label={t("serverview.add.show")} disabled={!server() || !repo()} onClick={show} />
    </div>
  );
}

/**
 * "Server changes" under the Changes tree: a read-only view of the working copy of each repository a server run works in (and of any
 * repository you add). It reads over the shared ssh connection every 4 s while a run is active there, slowly when idle, and not at all
 * while the panel is closed or the window hidden.
 */
export function ServerChangesPanel() {
  onMount(ensureServers);
  const shown = createMemo(() => shownViews());
  const [file, setFile] = createSignal<OpenFile | undefined>(undefined);
  const [xfer, setXfer] = createSignal<TransferTarget | undefined>(undefined);
  const pinnedKeys = createMemo(() => new Set(pinnedViews().map(keyOf)));
  const total = createMemo(() => shown().keys.reduce((n, k) => n + (viewEntry(k)?.data?.total ?? 0), 0));
  const visible = () => enabledServers().length > 0 || shown().keys.length > 0;

  createEffect(() => {
    if (!viewOpen()) return;
    const stop = untrack(() => startPolling());
    onCleanup(stop);
  });

  return (
    <Show when={visible()}>
      <section class="sv" aria-label={t("serverview.aria")} data-open={viewOpen() ? "" : undefined}>
        <div class="sv__bar">
          <button type="button" class="sv__toggle" aria-expanded={viewOpen()} onClick={() => setViewOpen(!viewOpen())}>
            <Icon icon={viewOpen() ? ChevronDown : ChevronRight} size={14} />
            <Icon icon={Server} size={14} />
            <span>{t("serverview.title")}</span>
            <Show when={total() > 0}>
              <Badge size="sm" numeric>{total()}</Badge>
            </Show>
          </button>
          <Show when={viewOpen()}>
            <IconButton icon={RefreshCw} size="sm" label={t("serverview.refreshAll")} onClick={() => shown().keys.forEach((k) => void refreshView(k))} />
          </Show>
        </div>
        <Show when={viewOpen()}>
          <div class="sv__body">
            <Show when={shown().keys.length > 0} fallback={<p class="sv-state">{t("serverview.none")}</p>}>
              <For each={shown().keys}>
                {(k) => <Group view={k} active={shown().active.has(keyOf(k))} pinned={pinnedKeys().has(keyOf(k)) && !shown().runs.has(keyOf(k))} onOpenFile={setFile} onTransfer={setXfer} />}
              </For>
            </Show>
            <AddView />
          </div>
        </Show>
      </section>
      <FileDialog file={file()} onClose={() => setFile(undefined)} />
      <TransferDialog target={xfer()} onClose={() => setXfer(undefined)} />
    </Show>
  );
}

export default ServerChangesPanel;
