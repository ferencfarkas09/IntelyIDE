import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { DeletePreview, DeleteReport } from "../../ipc/roles";
import { repos } from "../../store/workspace";
import { Button, Dialog, Input, Skeleton, TriangleAlert } from "../../ui-kit";
import { deleteErrorText } from "./rolesLogic";

export interface DeleteRequest {
  /** The group name: the word the user types. */
  name: string;
  ids: string[];
}

const repoName = (id: string | undefined) => repos().find((r) => r.id === id)?.name ?? id ?? "";

/**
 * Deleting role files for good (a backup of each is kept first). The engine checks everything again; this dialog only
 * shows what will happen and holds the confirmation: the exact role name has to be typed.
 */
export function DeleteRoleDialog(props: { request: DeleteRequest | undefined; onClose: () => void; onDeleted: (report: DeleteReport) => void }) {
  const [preview, setPreview] = createSignal<DeletePreview | undefined>(undefined);
  const [loadError, setLoadError] = createSignal<string | undefined>(undefined);
  const [typed, setTyped] = createSignal("");
  const [typedLink, setTypedLink] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<{ text: string; detail?: string } | undefined>(undefined);

  createEffect(
    on(
      () => props.request,
      (req) => {
        setPreview(undefined);
        setLoadError(undefined);
        setTyped("");
        setTypedLink("");
        setError(undefined);
        if (!req) return;
        ipc.roles.deletePreview(req.ids).then(setPreview, (e) => setLoadError(deleteErrorText(e)));
      },
    ),
  );

  const files = () => preview()?.files ?? [];
  const repoNotes = createMemo(() => [...new Set(files().filter((f) => f.scope === "repo").map((f) => repoName(f.repoId)))]);
  const hasGlobal = () => files().some((f) => f.scope === "global");
  const linkTarget = () => preview()?.linkTarget;
  const nameOk = () => typed() === props.request?.name;
  const linkOk = () => !linkTarget() || typedLink() === props.request?.name;
  const ready = () => !!preview() && nameOk() && linkOk() && !busy();

  const confirm = async () => {
    const req = props.request;
    if (!req || !ready()) return;
    setBusy(true);
    setError(undefined);
    try {
      props.onDeleted(await ipc.roles.delete(req.ids, typed(), linkTarget() ? { typedLink: typedLink() } : undefined));
    } catch (e) {
      setError({ text: deleteErrorText(e), detail: (e as { message?: string } | null)?.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!props.request}
      onClose={props.onClose}
      title={t("roles.deleteTitle", { name: props.request?.name ?? "" })}
      description={preview() ? t("roles.deleteDesc", { count: files().length, dir: preview()!.backupDir ?? t("roles.delete.noBackupDir") }) : undefined}
      size="md"
      role="alertdialog"
      class="roles-delete"
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            {t("roles.cancel")}
          </Button>
          <Button variant="danger" loading={busy()} disabled={!ready()} onClick={() => void confirm()}>
            {t("roles.deleteConfirm", { count: files().length || 1 })}
          </Button>
        </>
      }
    >
      <Show when={!loadError()} fallback={<p class="roles-delete__error" role="alert">{loadError()}</p>}>
        <Show when={preview()} fallback={<Skeleton height={48} />}>
          <ul class="roles-delete__files" aria-label={t("roles.deleteFiles")}>
            <For each={files()}>
              {(f) => (
                <li>
                  <code title={f.path}>{f.path}</code>
                  <Show when={f.symlinkTarget}>{(target) => <small class="roles-delete__link">{t("roles.delete.symlinkTarget", { target: target() })}</small>}</Show>
                </li>
              )}
            </For>
          </ul>
          <Show when={hasGlobal()}>
            <p class="roles-delete__note">{t("roles.delete.globalAffectsClaude")}</p>
          </Show>
          <For each={repoNotes()}>{(repo) => <p class="roles-delete__note">{t("roles.deleteRepoNote", { repo })}</p>}</For>
          <p class="roles-delete__note">{t("roles.deleteSyncNote")}</p>
          <label class="roles-delete__type">
            <span>{t("roles.deleteType", { name: props.request?.name ?? "" })}</span>
            <Input
              data-autofocus
              aria-label={t("roles.deleteTypeAria")}
              value={typed()}
              invalid={typed() !== "" && !nameOk()}
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => setTyped(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void confirm())}
            />
          </label>
          <Show when={linkTarget()}>
            <label class="roles-delete__type">
              <span class="roles-delete__link">
                <TriangleAlert size={12} /> {t("roles.delete.symlinkConfirm", { target: linkTarget() ?? "" })}
              </span>
              <Input aria-label={t("roles.delete.symlinkConfirmAria")} value={typedLink()} invalid={typedLink() !== "" && !linkOk()} autocomplete="off" spellcheck={false} onInput={(e) => setTypedLink(e.currentTarget.value)} />
            </label>
          </Show>
        </Show>
        <Show when={error()}>{(e) => <p class="roles-delete__error" role="alert" title={e().detail}>{e().text}</p>}</Show>
      </Show>
    </Dialog>
  );
}
