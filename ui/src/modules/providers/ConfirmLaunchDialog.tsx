import { createEffect, createSignal, Show } from "solid-js";
import { t } from "../../i18n";
import type { ProviderInfo } from "../../ipc/providers";
import { Button, Dialog, Input, TextArea, TriangleAlert } from "../../ui-kit";
import { argsFromLines, commandLine, launchProblem } from "./launch";

/**
 * The one-time confirmation of what the IDE will start ((design notes: providers-plan) 4.1): the full command line, nothing hidden.
 * A provider with a fixed proposal shows it read-only (only the program path was found by detection); a custom ACP agent
 * takes the program and its arguments here. The backend stores what is confirmed with a hash, so a changed line asks again.
 */
export function ConfirmLaunchDialog(props: { open: boolean; provider: ProviderInfo; onClose: () => void; onConfirm: (command: string, args: string[]) => Promise<void> | void }) {
  const launch = () => props.provider.launch;
  const [command, setCommand] = createSignal("");
  const [argText, setArgText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  createEffect(() => {
    if (!props.open) return;
    setCommand(launch()?.command ?? "");
    setArgText((launch()?.args ?? []).join("\n"));
  });
  const editable = () => !!launch()?.editable;
  const args = () => (editable() ? argsFromLines(argText()) : (launch()?.args ?? []));
  const problem = () => launchProblem(command());

  async function submit() {
    if (problem() || busy()) return;
    setBusy(true);
    try {
      await props.onConfirm(command().trim(), args());
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      size="md"
      role="alertdialog"
      title={t("providers.confirm.title", { name: props.provider.name })}
      description={t("providers.confirm.desc")}
      footer={
        <>
          <Button variant="secondary" onClick={props.onClose}>{t("providers.confirm.cancel")}</Button>
          <Button variant="primary" loading={busy()} disabled={!!problem()} onClick={() => void submit()}>{t("providers.confirm.submit")}</Button>
        </>
      }
    >
      <div class="confirm">
        <Show
          when={editable()}
          fallback={
            <dl class="confirm__facts">
              <dt>{t("providers.confirm.program")}</dt>
              <dd><code class="confirm__code">{command() || "—"}</code></dd>
              <dt>{t("providers.confirm.args")}</dt>
              <dd><code class="confirm__code">{args().length ? args().join(" ") : t("providers.confirm.argsNone")}</code></dd>
            </dl>
          }
        >
          <label class="confirm__field">
            <span>{t("providers.confirm.programLabel")}</span>
            <Input data-autofocus size="sm" aria-label={t("providers.confirm.programLabel")} autocomplete="off" spellcheck={false} placeholder="/usr/local/bin/tool" invalid={!!command() && !!problem()} value={command()} onInput={(e) => setCommand(e.currentTarget.value)} />
          </label>
          <label class="confirm__field">
            <span>{t("providers.confirm.argsLabel")}</span>
            <TextArea aria-label={t("providers.confirm.argsLabel")} minRows={2} maxRows={6} spellcheck={false} value={argText()} onInput={(e) => setArgText(e.currentTarget.value)} />
          </label>
        </Show>
        <div class="confirm__line">
          <span class="confirm__label">{t("providers.confirm.line")}</span>
          <code class="confirm__code confirm__code--full" aria-label={t("providers.confirm.line")}>{command().trim() ? commandLine(command().trim(), args()) : "—"}</code>
        </div>
        <Show when={command() && problem() === "relative"}>
          <p class="confirm__problem" role="alert"><TriangleAlert size={14} aria-hidden="true" /> {t("providers.confirm.absolute")}</p>
        </Show>
        <p class="confirm__note">{t("providers.confirm.weak", { name: props.provider.name })}</p>
      </div>
    </Dialog>
  );
}
