import { createEffect, createMemo, createSignal, createUniqueId, on, onCleanup, Show } from "solid-js";
import { createStore, produce, unwrap } from "solid-js/store";
import { t, type MessageKey } from "../../i18n";
import { ipc } from "../../ipc";
import type { McpSaveInput, McpServerView, McpTransport } from "../../ipc/mcp";
import { Button, Dialog, FormGroup, FormRow, Input, SegmentedControl, Switch, TextArea } from "../../ui-kit";
import { argsFromText, argsProblem, argsToText, commandProblem, editorErrorKey, errorField, errorInfo, nameProblem, urlProblem, type EditorField } from "./logic";
import { VarListEditor } from "./VarListEditor";
import { blankRow, firstRowProblem, rowsFromViews, rowsSnapshot, rowsToInputs, type VarRow } from "./varRows";

export interface ServerEditorProps {
  open: boolean;
  /** The record being edited; none = a new server. */
  server?: McpServerView;
  /** Names of every server: the one being edited is left out here. */
  existingNames: readonly string[];
  readOnly?: boolean;
  onClose: () => void;
  /** The saved view; `thenTest`: the user chose "Save and test". */
  onSaved: (view: McpServerView, thenTest: boolean) => void;
}

type Errors = Partial<Record<EditorField, { key: MessageKey; message?: string }>>;

/**
 * Add or edit one server ((design notes: mcp-management-spec) 7.3). Stored secrets are never shown: a secret slot that is left alone sends no
 * value and keeps its Keychain item. The text typed for a secret is read once for `mcp_save`, then cleared with the call, on close and
 * on unmount. Errors come back as stable codes (`mcp.err.*`) and are shown under the field they are about.
 */
export function ServerEditor(props: ServerEditorProps) {
  const [name, setName] = createSignal("");
  const [transport, setTransport] = createSignal<McpTransport>("stdio");
  const [command, setCommand] = createSignal("");
  const [argsText, setArgsText] = createSignal("");
  const [url, setUrl] = createSignal("");
  const [enabled, setEnabled] = createSignal(true);
  const [env, setEnv] = createStore<{ rows: VarRow[] }>({ rows: [] });
  const [headers, setHeaders] = createStore<{ rows: VarRow[] }>({ rows: [] });
  const [errors, setErrors] = createSignal<Errors>({});
  const [busy, setBusy] = createSignal(false);
  const [discard, setDiscard] = createSignal(false);
  const [initial, setInitial] = createSignal("");
  const ids = { name: createUniqueId(), command: createUniqueId(), args: createUniqueId(), url: createUniqueId() };

  const snapshot = () => JSON.stringify([name(), transport(), command(), argsText(), url(), enabled(), rowsSnapshot(env.rows), rowsSnapshot(headers.rows)]);
  const typedSecret = () => [...env.rows, ...headers.rows].some((r) => r.secretValue !== "");
  const dirty = createMemo(() => props.open && (snapshot() !== initial() || typedSecret()));
  const stdio = () => transport() === "stdio";

  function wipeSecrets() {
    setEnv("rows", produce((rows) => rows.forEach((r) => (r.secretValue = ""))));
    setHeaders("rows", produce((rows) => rows.forEach((r) => (r.secretValue = ""))));
  }

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) {
          wipeSecrets();
          return;
        }
        const s = props.server;
        setName(s?.name ?? "");
        setTransport(s?.transport ?? "stdio");
        setCommand(s?.command ?? "");
        setArgsText(argsToText(s?.args ?? []));
        setUrl(s?.url ?? "");
        setEnabled(s?.enabled ?? true);
        setEnv("rows", rowsFromViews(s?.env ?? []));
        setHeaders("rows", rowsFromViews(s?.headers ?? []));
        setErrors({});
        setDiscard(false);
        setInitial(snapshot());
      },
    ),
  );
  onCleanup(wipeSecrets);

  const patchRows = (set: typeof setEnv) => (key: number, patch: Partial<VarRow>) => set("rows", (r) => r.key === key, patch);
  const removeRow = (set: typeof setEnv) => (key: number) => set("rows", (rows) => rows.filter((r) => r.key !== key));
  const addRow = (set: typeof setEnv) => () => set("rows", (rows) => [...rows, blankRow()]);

  /** What can be refused before anything is sent: the first problem per field. Rust still validates everything. */
  function localErrors(): Errors {
    const out: Errors = {};
    const bad = nameProblem(name().trim(), props.existingNames);
    if (bad) out.name = { key: editorErrorKey(bad) };
    if (stdio()) {
      const c = commandProblem(command());
      if (c) out.command = { key: editorErrorKey(c) };
      const a = argsProblem(argsFromText(argsText()));
      if (a) out.args = { key: editorErrorKey(a) };
      const v = firstRowProblem("env", env.rows);
      if (v) out.vars = { key: v === "requirePlain" ? "mcp.var.requirePlain" : editorErrorKey(v) };
    } else {
      const u = urlProblem(url());
      if (u) out.url = { key: editorErrorKey(u) };
      const v = firstRowProblem("header", headers.rows);
      if (v) out.vars = { key: v === "requirePlain" ? "mcp.var.requirePlain" : editorErrorKey(v) };
    }
    return out;
  }

  async function save(thenTest: boolean) {
    if (busy()) return;
    const local = localErrors();
    setErrors(local);
    if (Object.keys(local).length) return;
    const input: McpSaveInput = {
      ...(props.server ? { id: props.server.id } : {}),
      name: name().trim(),
      transport: transport(),
      enabled: enabled(),
      ...(stdio()
        ? { command: command().trim(), args: argsFromText(argsText()), env: rowsToInputs(unwrap(env.rows)) }
        : { url: url().trim(), headers: rowsToInputs(unwrap(headers.rows)) }),
    };
    setBusy(true);
    try {
      const view = await ipc.mcp.save(input);
      props.onSaved(view, thenTest);
    } catch (e) {
      const info = errorInfo(e);
      const key = editorErrorKey(info.code);
      setErrors({ [errorField(info.code)]: { key, message: key === "mcp.err.generic" ? info.message : undefined } });
    } finally {
      // the typed secrets were in the request; they are not kept for a retry
      wipeSecrets();
      setBusy(false);
    }
  }

  function requestClose() {
    if (busy()) return;
    if (dirty()) setDiscard(true);
    else props.onClose();
  }

  const errorText = (field: EditorField) => {
    const e = errors()[field];
    return e ? t(e.key, { message: e.message ?? "" }) : undefined;
  };
  const fieldError = (field: EditorField, id: string) => (
    <Show when={errorText(field)}>{(text) => <p class="mcp-field-error" id={`${id}-err`} role="alert">{text()}</p>}</Show>
  );

  return (
    <>
      <Dialog
        open={props.open}
        onClose={requestClose}
        size="lg"
        title={props.server ? t("mcp.editor.titleEdit", { name: props.server.name }) : t("mcp.editor.titleNew")}
        footer={
          <>
            <Button variant="secondary" onClick={requestClose}>{t("mcp.cancel")}</Button>
            <Button variant="secondary" disabled={busy() || props.readOnly} onClick={() => void save(true)}>{t("mcp.editor.saveTest")}</Button>
            <Button variant="primary" loading={busy()} disabled={props.readOnly} onClick={() => void save(false)}>{t("mcp.editor.save")}</Button>
          </>
        }
      >
        <div class="mcp-editor">
          <FormGroup>
            <FormRow label={t("mcp.field.name")} description={t("mcp.field.nameHint")} labelFor={ids.name}>
              <div class="mcp-field">
                <Input id={ids.name} data-autofocus size="sm" class="mcp-mono" autocomplete="off" spellcheck={false} autocapitalize="off" aria-describedby={errorText("name") ? `${ids.name}-err` : undefined} invalid={!!errorText("name")} value={name()} onInput={(e) => setName(e.currentTarget.value)} />
                {fieldError("name", ids.name)}
              </div>
            </FormRow>
            <FormRow label={t("mcp.field.transport")}>
              <SegmentedControl<McpTransport>
                size="sm"
                aria-label={t("mcp.field.transport")}
                value={transport()}
                onChange={setTransport}
                options={[
                  { value: "stdio", label: t("mcp.transport.stdio") },
                  { value: "http", label: t("mcp.transport.http") },
                ]}
              />
            </FormRow>
            <Show
              when={stdio()}
              fallback={
                <>
                  <FormRow label={t("mcp.field.url")} description={t("mcp.field.urlHint")} labelFor={ids.url}>
                    <div class="mcp-field">
                      <Input id={ids.url} size="sm" class="mcp-mono" type="url" placeholder="https://" autocomplete="off" spellcheck={false} autocapitalize="off" aria-describedby={errorText("url") ? `${ids.url}-err` : undefined} invalid={!!errorText("url")} value={url()} onInput={(e) => setUrl(e.currentTarget.value)} />
                      {fieldError("url", ids.url)}
                    </div>
                  </FormRow>
                  <FormRow label={t("mcp.field.headers")} description={t("mcp.field.headersHint")} stacked>
                    <VarListEditor kind="header" label={t("mcp.field.headers")} rows={headers.rows} onPatch={patchRows(setHeaders)} onAdd={addRow(setHeaders)} onRemove={removeRow(setHeaders)} />
                    {fieldError("vars", "mcp-headers")}
                  </FormRow>
                </>
              }
            >
              <FormRow label={t("mcp.field.command")} description={t("mcp.field.commandHint")} labelFor={ids.command}>
                <div class="mcp-field">
                  <Input id={ids.command} size="sm" class="mcp-mono" placeholder="npx" autocomplete="off" spellcheck={false} autocapitalize="off" aria-describedby={errorText("command") ? `${ids.command}-err` : undefined} invalid={!!errorText("command")} value={command()} onInput={(e) => setCommand(e.currentTarget.value)} />
                  {fieldError("command", ids.command)}
                </div>
              </FormRow>
              <FormRow label={t("mcp.field.args")} description={t("mcp.field.argsHint")} labelFor={ids.args}>
                <div class="mcp-field">
                  <TextArea id={ids.args} class="mcp-mono" minRows={2} maxRows={6} spellcheck={false} autocapitalize="off" aria-describedby={errorText("args") ? `${ids.args}-err` : undefined} invalid={!!errorText("args")} value={argsText()} onInput={(e) => setArgsText(e.currentTarget.value)} />
                  {fieldError("args", ids.args)}
                </div>
              </FormRow>
              <FormRow label={t("mcp.field.env")} stacked>
                <VarListEditor kind="env" label={t("mcp.field.env")} rows={env.rows} onPatch={patchRows(setEnv)} onAdd={addRow(setEnv)} onRemove={removeRow(setEnv)} />
                {fieldError("vars", "mcp-env")}
              </FormRow>
            </Show>
            <FormRow label={t("mcp.field.enabled")} description={t("mcp.field.enabledHint")}>
              <Switch checked={enabled()} onChange={setEnabled} aria-label={t("mcp.field.enabled")} />
            </FormRow>
          </FormGroup>
          {fieldError("form", "mcp-form")}
        </div>
      </Dialog>
      <Dialog
        open={discard()}
        onClose={() => setDiscard(false)}
        role="alertdialog"
        size="sm"
        title={t("mcp.editor.discardTitle")}
        description={t("mcp.editor.discardBody")}
        footer={
          <>
            <Button variant="secondary" data-autofocus onClick={() => setDiscard(false)}>{t("mcp.editor.discardKeep")}</Button>
            <Button variant="danger" onClick={() => (setDiscard(false), props.onClose())}>{t("mcp.editor.discard")}</Button>
          </>
        }
      />
    </>
  );
}
