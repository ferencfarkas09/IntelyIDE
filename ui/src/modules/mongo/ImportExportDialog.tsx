import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import type { DialogHandle, ImportPreview, ImportReport, Note, ProfileView } from "../../ipc/mongo";
import { Button, Checkbox, CircleAlert, Dialog, Download, Info, Skeleton, toast, TriangleAlert, Upload } from "../../ui-kit";
import { noteKnown, selectedIndexes } from "./onboarding/logic";
import { codeOf, messageOf, refreshProfiles } from "./store";
import "./manage.css";

const noteText = (n: Note): string => {
  const sentence = noteKnown(n.code) ? t(`mongoForm.note.${n.code as "duplicate"}`) : t("mongoForm.note.other");
  return n.option ? `${n.option} ${sentence}` : sentence;
};

/** Errors from the import/export commands, in words (the Rust message can carry a path or a host: it is not shown raw). */
export function ioErrorText(e: unknown): string {
  switch (codeOf(e)) {
    case "mongoHandle": return t("mongoManage.io.handleExpired");
    case "mongoImport": return t("mongoManage.io.badFile");
    case "readOnly": case "testJail": return t("mongoManage.io.jail");
    default: return t("mongoManage.io.failed", { message: messageOf(e) });
  }
}

// ---- Export (F8) -----------------------------------------------------------------------------------------------------------

export interface ExportDialogProps {
  profiles: readonly ProfileView[];
  /** Pre-ticked profiles (the card menu's "Export this"); everything when empty. */
  preselect?: readonly string[];
  onClose: () => void;
}

/**
 * Pick profiles and two options, then Rust opens the native save dialog (the page never supplies or sees a path) and writes
 * the file. Passwords and passphrases are never exported; SSH tunnel settings default on, file paths default off.
 */
export function ExportDialog(props: ExportDialogProps) {
  const [ticked, setTicked] = createSignal<string[]>(props.preselect?.length ? [...props.preselect] : props.profiles.map((p) => p.id));
  const [tunnel, setTunnel] = createSignal(true);
  const [paths, setPaths] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const all = () => ticked().length === props.profiles.length;
  const toggle = (id: string) => setTicked((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));

  async function run() {
    setBusy(true);
    setError(undefined);
    try {
      const handle = await ipc.mongo.dialogSave("export", "intely-mongo-profiles.json");
      if (!handle) return;
      const r = await ipc.mongo.profilesExport(ticked(), { includeTunnel: tunnel(), includePaths: paths() }, handle.token);
      toast.success(t("mongoManage.export.done", { count: r.count }), handle.fileName ?? undefined);
      props.onClose();
    } catch (e) {
      setError(ioErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      size="md"
      onClose={props.onClose}
      title={t("mongoManage.export.title")}
      description={t("mongoManage.export.body")}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>{t("mongoManage.cancel")}</Button>
          <Button variant="primary" icon={Upload} loading={busy()} disabled={!ticked().length || busy()} onClick={() => void run()}>{t("mongoManage.export.button")}</Button>
        </>
      }
    >
      <div class="mm-io">
        <Checkbox size="sm" checked={all() ? true : ticked().length ? "mixed" : false} onChange={(v) => setTicked(v ? props.profiles.map((p) => p.id) : [])} label={t("mongoManage.io.all", { count: props.profiles.length })} />
        <ul class="mm-io__list" aria-label={t("mongoManage.export.list")}>
          <For each={props.profiles}>
            {(p) => (
              <li>
                <Checkbox size="sm" checked={ticked().includes(p.id)} onChange={() => toggle(p.id)} label={<span class="mm-io__name"><span class="ui-truncate">{p.name}</span><span class="mm-io__host ui-mono" dir="ltr">{p.host}</span></span>} />
              </li>
            )}
          </For>
        </ul>
        <div class="mm-io__opts">
          <Checkbox size="sm" checked={tunnel()} onChange={setTunnel} label={t("mongoManage.export.tunnel")} />
          <Checkbox size="sm" checked={paths()} onChange={setPaths} label={t("mongoManage.export.paths")} />
          <Show when={paths()}><p class="mm-hint">{t("mongoManage.export.pathsNote")}</p></Show>
        </div>
        <p class="mm-banner" data-tone="info" role="note"><Info size={14} aria-hidden="true" /> <span>{t("mongoManage.export.noSecrets")}</span></p>
        <Show when={error()}><p class="mm-banner" data-tone="danger" role="alert"><CircleAlert size={14} aria-hidden="true" /> <span>{error()}</span></p></Show>
      </div>
    </Dialog>
  );
}

// ---- Import (F8) -----------------------------------------------------------------------------------------------------------

export interface ImportDialogProps {
  /** The one-time handle of the file Rust picked in its own native dialog. */
  handle: DialogHandle;
  onClose: () => void;
  onImported?: (r: ImportReport) => void;
}

/**
 * Dry-run first: every profile with its warnings and, for the risky ones (tunnel, proxy, PLAIN, TLS off, non-loopback host),
 * every endpoint it would contact. Imported profiles are always read-only with AI off; passwords are never in a file.
 */
export function ImportDialog(props: ImportDialogProps) {
  const [preview, setPreview] = createSignal<ImportPreview>();
  const [checked, setChecked] = createSignal<boolean[]>([]);
  const [error, setError] = createSignal<string>();
  const [busy, setBusy] = createSignal(false);
  const [report, setReport] = createSignal<ImportReport>();

  onMount(() => {
    void ipc.mongo
      .profilesImportPreview(props.handle.token)
      .then((p) => (setPreview(p), setChecked(p.items.map(() => true))))
      .catch((e) => setError(ioErrorText(e)));
  });

  const count = createMemo(() => checked().filter(Boolean).length);
  const risky = createMemo(() => (preview()?.items ?? []).filter((it, i) => checked()[i] && it.needsConfirm).length);

  async function run() {
    setBusy(true);
    setError(undefined);
    try {
      const r = await ipc.mongo.profilesImport(props.handle.token, selectedIndexes(checked()));
      await refreshProfiles();
      setReport(r);
      props.onImported?.(r);
      toast.success(t("mongoManage.import.done", { count: r.imported }));
    } catch (e) {
      setError(ioErrorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      size="lg"
      onClose={props.onClose}
      title={t("mongoManage.import.title")}
      description={props.handle.fileName ? t("mongoManage.import.file", { file: props.handle.fileName }) : t("mongoManage.import.body")}
      footer={
        <Show
          when={!report()}
          fallback={<Button variant="primary" data-autofocus onClick={props.onClose}>{t("mongoManage.close")}</Button>}
        >
          <Button variant="ghost" onClick={props.onClose}>{t("mongoManage.cancel")}</Button>
          <Button variant="primary" icon={Download} loading={busy()} disabled={!count() || busy() || !preview()} onClick={() => void run()}>{t("mongoManage.import.button", { count: count() })}</Button>
        </Show>
      }
    >
      <div class="mm-io">
        <Show when={error()}><p class="mm-banner" data-tone="danger" role="alert"><CircleAlert size={14} aria-hidden="true" /> <span>{error()}</span></p></Show>
        <Show when={!report()} fallback={<ImportResult report={report()!} />}>
          <Show when={preview()} fallback={<Show when={!error()}><div aria-busy="true"><Skeleton height={64} /></div></Show>}>
            {(p) => (
              <>
                <p class="mm-hint">{t("mongoManage.import.safe")}</p>
                <For each={p().notes}>{(n) => <p class="mm-banner" data-tone="warn" role="note"><TriangleAlert size={14} aria-hidden="true" /> <span>{noteText(n)}</span></p>}</For>
                <ul class="mm-io__preview" aria-label={t("mongoManage.import.list")}>
                  <For each={p().items}>
                    {(it, i) => (
                      <li class="mm-io__item" data-risky={it.needsConfirm ? "" : undefined}>
                        <Checkbox size="sm" checked={!!checked()[i()]} onChange={(v) => setChecked((c) => c.map((x, j) => (j === i() ? v : x)))} label={<strong class="ui-truncate">{it.name}</strong>} />
                        <Show when={it.endpoints.length}>
                          <div class="mm-io__ends">
                            <span class="mm-io__ends-label">{t("mongoManage.import.contacts")}</span>
                            <For each={it.endpoints}>{(e) => <code class="mm-io__end" dir="ltr">{e}</code>}</For>
                          </div>
                        </Show>
                        <For each={it.warnings}>{(w) => <p class="mm-io__warn"><TriangleAlert size={12} aria-hidden="true" /> {noteText(w)}</p>}</For>
                        <Show when={it.needsConfirm}><p class="mm-io__warn"><Info size={12} aria-hidden="true" /> {t("mongoManage.import.willAsk")}</p></Show>
                      </li>
                    )}
                  </For>
                </ul>
                <Show when={risky()}><p class="mm-banner" data-tone="warn" role="note"><TriangleAlert size={14} aria-hidden="true" /> <span>{t("mongoManage.import.risky", { count: risky() })}</span></p></Show>
              </>
            )}
          </Show>
        </Show>
      </div>
    </Dialog>
  );
}

function ImportResult(props: { report: ImportReport }) {
  return (
    <div class="mm-io__result" role="status">
      <p>{t("mongoManage.import.result", { imported: props.report.imported, skipped: props.report.skipped })}</p>
      <p class="mm-hint">{t("mongoManage.import.needPassword")}</p>
      <For each={props.report.notes}>{(n) => <p class="mm-banner" data-tone="warn" role="note"><TriangleAlert size={14} aria-hidden="true" /> <span>{noteText(n)}</span></p>}</For>
    </div>
  );
}
