import { createSignal, For, Show } from "solid-js";
import { t } from "../../i18n";
import type { McpServerView, McpVarView } from "../../ipc/mcp";
import { Badge, Button, Dialog, Lock, TriangleAlert } from "../../ui-kit";
import { escapeForDisplay } from "./logic";

export interface ConfirmRunDialogProps {
  open: boolean;
  server: McpServerView | undefined;
  /** Opened by a Test: the primary button says "Confirm and test". */
  thenTest?: boolean;
  /** The record or a file it runs changed under the open dialog: read it again. */
  changed?: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void> | void;
}

/** A label (`xn--`) of an internationalised host in its encoded form: the dialog says to check it. */
const isIdn = (host: string | undefined) => !!host && host.split(".").some((label) => label.toLowerCase().startsWith("xn--"));

function VarLine(props: { v: McpVarView }) {
  return (
    <li class="mcp-confirm__var">
      <code class="mcp-code-inline">{escapeForDisplay(props.v.name)}</code>
      <Show when={props.v.secret} fallback={<><span class="mcp-confirm__eq">=</span><code class="mcp-code-inline">{escapeForDisplay(props.v.value ?? "")}</code></>}>
        <Badge size="sm" icon={Lock}>{t("mcp.confirm.secretTag")}</Badge>
      </Show>
    </li>
  );
}

/**
 * The only control for "run this program" ((design notes: mcp-management-spec) 7.4, 6.5). It renders what Rust sends and never re-interprets it:
 * `argsDisplay`, `commandLine`, `codeFiles` and `urlHost` arrive escaped, and nothing is truncated. Cancel has the initial focus.
 */
export function ConfirmRunDialog(props: ConfirmRunDialogProps) {
  const [busy, setBusy] = createSignal(false);
  const s = () => props.server;
  const vars = () => (s()?.transport === "http" ? (s()?.headers ?? []) : (s()?.env ?? []));

  async function confirm() {
    if (busy()) return;
    setBusy(true);
    try {
      await props.onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onCancel}
      role="alertdialog"
      size="lg"
      title={s()?.transport === "http" ? t("mcp.confirm.titleHttp") : t("mcp.confirm.title")}
      footer={
        <>
          <Button variant="secondary" data-autofocus onClick={props.onCancel}>{t("mcp.cancel")}</Button>
          <Button variant="primary" loading={busy()} onClick={() => void confirm()}>{props.thenTest ? t("mcp.confirm.okTest") : t("mcp.confirm.ok")}</Button>
        </>
      }
    >
      <Show when={s()}>
        {(server) => (
          <div class="mcp-confirm">
            <p class="mcp-confirm__body">{t("mcp.confirm.body", { name: server().name })}</p>
            <Show when={props.changed}>
              <div class="mcp-note" data-tone="warn" role="status"><TriangleAlert size={14} aria-hidden="true" /><span>{t("mcp.confirm.changed")}</span></div>
            </Show>
            <Show when={server().imported && vars().some((v) => v.secret)}>
              <div class="mcp-note" data-tone="warn"><TriangleAlert size={14} aria-hidden="true" /><span>{t("mcp.confirm.hiddenValues")}</span></div>
            </Show>
            <Show when={server().fetchesCode}>
              <div class="mcp-note" data-tone="warn"><TriangleAlert size={14} aria-hidden="true" /><span>{t("mcp.confirm.unpinned")}</span></div>
            </Show>

            <Show
              when={server().transport === "stdio"}
              fallback={
                <>
                  <section class="mcp-confirm__block">
                    <h4 class="mcp-confirm__label">{t("mcp.confirm.address")}</h4>
                    <code class="mcp-code">{escapeForDisplay(server().url ?? "")}</code>
                  </section>
                  <section class="mcp-confirm__block">
                    <h4 class="mcp-confirm__label">{t("mcp.confirm.host")}</h4>
                    <code class="mcp-code">{server().urlHost}</code>
                    <Show when={isIdn(server().urlHost)}>
                      <div class="mcp-note" data-tone="warn"><TriangleAlert size={14} aria-hidden="true" /><span>{t("mcp.confirm.idn")}</span></div>
                    </Show>
                  </section>
                </>
              }
            >
              <section class="mcp-confirm__block">
                <h4 class="mcp-confirm__label">{t("mcp.confirm.command")}</h4>
                <code class="mcp-code">{escapeForDisplay(server().command ?? "")}</code>
              </section>
              <section class="mcp-confirm__block">
                <h4 class="mcp-confirm__label">{t("mcp.confirm.args", { count: server().argsDisplay.length })}</h4>
                <Show when={server().argsDisplay.length > 0}>
                  <ol class="mcp-args" aria-label={t("mcp.confirm.args", { count: server().argsDisplay.length })}>
                    <For each={server().argsDisplay}>{(arg) => <li class="mcp-args__item"><code>{arg}</code></li>}</For>
                  </ol>
                </Show>
              </section>
              <Show when={server().codeFiles.length > 0}>
                <section class="mcp-confirm__block">
                  <h4 class="mcp-confirm__label">{t("mcp.confirm.files")}</h4>
                  <ul class="mcp-files">
                    <For each={server().codeFiles}>{(f) => <li><code class="mcp-code-inline">{f.path}</code><span class="mcp-files__sha">{f.sha256}</span></li>}</For>
                  </ul>
                </section>
              </Show>
            </Show>

            <Show when={vars().length > 0}>
              <section class="mcp-confirm__block">
                <h4 class="mcp-confirm__label">{t("mcp.confirm.vars")}</h4>
                <ul class="mcp-confirm__vars">
                  <For each={vars()}>{(v) => <VarLine v={v} />}</For>
                </ul>
              </section>
            </Show>
          </div>
        )}
      </Show>
    </Dialog>
  );
}
