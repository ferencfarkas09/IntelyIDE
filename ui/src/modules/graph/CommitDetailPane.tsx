import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { ChangedPath, FileKind } from "../../ipc/graph";
import { refreshSnapshots, snapshots } from "../../store/snapshots";
import { repoConfig } from "../../store/workspace";
import { Button, Copy, CornerDownLeft, GitMerge, Icon, IconButton, Input, Rewind, Skeleton, StatusLetter, toast, TriangleAlert, type ChangeKindName } from "../../ui-kit";
import { fullDate, shortOid } from "./format";
import { cherryConfirm, reloadLog, setCherryConfirm, type LogSelection } from "./logState";
import { describeOp, errorMessage, needsLiveConfirm, opBlocked } from "./ops";
import { openCommitFile } from "./openers";
import { openRebase } from "./rebaseState";

const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const KIND: Record<FileKind, ChangeKindName> = { added: "added", modified: "modified", deleted: "deleted", renamed: "renamed", copied: "copied", typeChange: "typeChanged" };

/** Message, author, date and files of the commit selected in the log. A file opens its diff as a tab. */
export function CommitDetailPane(props: { selection: LogSelection }) {
  const [detail] = createResource(
    () => props.selection,
    (sel) => ipc.graph.commitDetail(sel.repoId, sel.oid),
  );
  const [busy, setBusy] = createSignal(false);
  const [liveAsk, setLiveAsk] = createSignal(false);
  const [typed, setTyped] = createSignal("");
  createEffect(
    on(
      () => props.selection,
      () => {
        setCherryConfirm(false);
        setLiveAsk(false);
        setTyped("");
      },
      { defer: true },
    ),
  );
  const repo = () => repoConfig(props.selection.repoId);
  const branch = () => snapshots()[props.selection.repoId]?.head.branch ?? "";

  const copyOid = () =>
    navigator.clipboard?.writeText(props.selection.oid).then(
      () => toast.info(t("graph.detail.copied"), shortOid(props.selection.oid)),
      () => toast.error(t("graph.detail.copyFail")),
    );

  const cherryPick = async () => {
    setBusy(true);
    try {
      const outcome = await ipc.graph.cherryPick(props.selection.repoId, [props.selection.oid], liveAsk() ? typed() : undefined);
      if (opBlocked(outcome)) toast.warn(describeOp(outcome), outcome.conflictFiles.join("\n") || undefined);
      else toast.success(t("graph.detail.cherryDone"), branch() ? t("graph.detail.cherryDoneOnto", { oid: shortOid(props.selection.oid), branch: branch() }) : t("graph.detail.cherryDoneCurrent", { oid: shortOid(props.selection.oid) }));
      setCherryConfirm(false);
      await Promise.all([refreshSnapshots(props.selection.repoId), reloadLog()]);
    } catch (err) {
      if (needsLiveConfirm(err)) setLiveAsk(true);
      else {
        toast.error(t("graph.detail.cherryFail"), errorMessage(err));
        setCherryConfirm(false);
      }
    } finally {
      setBusy(false);
    }
  };

  const body = (message: string, subject: string) => message.replace(subject, "").trim();

  return (
    <aside class="gdetail" aria-label={t("graph.detail.label")}>
      <Show when={!detail.error} fallback={<p class="gdetail__error"><Icon icon={TriangleAlert} size={14} /> {errorMessage(detail.error)}</p>}>
        <Show when={detail()} fallback={<div class="gdetail__loading" aria-busy="true"><Skeleton height={16} width="70%" /><Skeleton height={12} width="45%" /><Skeleton height={12} width="90%" /></div>}>
          {(d) => (
            <>
              <header class="gdetail__head">
                <h3 class="gdetail__subject">{d().subject}</h3>
                <p class="gdetail__meta">
                  <span class="gdetail__repo" style={{ "--repo": repo()?.color }}>{repo()?.name ?? props.selection.repoId}</span>
                  <span>{d().author}</span>
                  <span>{fullDate(d().dateMs)}</span>
                </p>
                <p class="gdetail__oid">
                  <code class="ui-mono" title={d().oid}>{d().shortOid}</code>
                  <IconButton icon={Copy} size="sm" label={t("graph.detail.copyId")} onClick={() => void copyOid()} />
                  <Show when={d().parents.length > 1}>
                    <span class="gdetail__merge"><Icon icon={GitMerge} size={12} /> {t("graph.detail.mergeOf", { parents: d().parents.map(shortOid).join(" + ") })}</span>
                  </Show>
                </p>
              </header>
              <Show when={body(d().message, d().subject)}>{(text) => <pre class="gdetail__body">{text()}</pre>}</Show>
              <div class="gdetail__actions">
                <Show when={cherryConfirm()} fallback={<Button size="sm" variant="secondary" icon={CornerDownLeft} onClick={() => setCherryConfirm(true)}>{t("graph.detail.cherryPick")}</Button>}>
                  <Button size="sm" variant="primary" loading={busy()} disabled={liveAsk() && (branch() === "" || typed() !== branch())} onClick={() => void cherryPick()}>{branch() ? t("graph.detail.apply", { branch: branch() }) : t("graph.detail.applyCurrent")}</Button>
                  <Button size="sm" variant="ghost" onClick={() => (setCherryConfirm(false), setLiveAsk(false))}>{t("graph.cancel")}</Button>
                </Show>
                <Button size="sm" variant="ghost" icon={Rewind} onClick={() => openRebase(props.selection.repoId, props.selection.oid)}>{t("graph.detail.rebaseHere")}</Button>
              </div>
              <Show when={liveAsk() && cherryConfirm()}>
                <label class="gdetail__live">
                  <span>{t("graph.detail.liveBranch", { branch: branch() })}</span>
                  <Input size="sm" aria-label={t("graph.typeConfirm", { branch: branch() })} value={typed()} onInput={(e) => setTyped(e.currentTarget.value)} />
                </label>
              </Show>
              <h4 class="gdetail__files-title">{t("graph.detail.files")} <span class="ui-tnum">{d().files.length}</span><span class="gdetail__totals ui-tnum"><span class="ghunk__added">+{d().additions}</span> <span class="ghunk__removed">-{d().deletions}</span></span></h4>
              <ul class="gdetail__files" aria-label={t("graph.detail.changedFiles")}>
                <For each={d().files}>
                  {(file: ChangedPath) => (
                    <li>
                      <button type="button" class="gdetail__file" onClick={() => openCommitFile(d().repoId, d().oid, { path: file.path, origPath: file.origPath ?? undefined })} title={file.path}>
                        <StatusLetter kind={KIND[file.kind]} />
                        <span class="gdetail__file-name" classList={{ "ui-file-deleted": file.kind === "deleted" }}>{nameOf(file.path)}</span>
                        <Show when={dirOf(file.path)}><span class="ui-path-hint ui-truncate">{dirOf(file.path)}</span></Show>
                        <Show when={!file.binary && file.additions != null}><span class="gdetail__counts ui-tnum"><span class="ghunk__added">+{file.additions}</span> <span class="ghunk__removed">-{file.deletions}</span></span></Show>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </>
          )}
        </Show>
      </Show>
    </aside>
  );
}
