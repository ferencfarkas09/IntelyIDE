import { createSignal, Show } from "solid-js";
import { t } from "../../i18n";
import { ipc } from "../../ipc";
import { errorText } from "../../store/snapshots";
import type { ProbeReport } from "../../ipc/providers";
import { Button, Play } from "../../ui-kit";
import { PERMISSION_LABEL } from "../../components/chat/format";
import "./providers.css";

/**
 * "Test run": one read-only session in an empty scratch folder, no prompt, no model call, nothing written. It shows what the
 * adapter negotiated (model, mode, capabilities). Used on the provider card and in the Roles editor.
 */
export function TestRun(props: { provider: string; name: string; model?: string; disabled?: boolean; disabledReason?: string; onNegotiated?: (r: ProbeReport) => void }) {
  const [busy, setBusy] = createSignal(false);
  const [report, setReport] = createSignal<ProbeReport | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      const r = await ipc.providers.testRun(props.provider, props.model);
      setReport(r);
      if (r.ok) props.onNegotiated?.(r);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span class="testrun">
      <Button size="sm" icon={Play} loading={busy()} disabled={props.disabled} title={props.disabled ? props.disabledReason : t("providers.testRun.explain")} onClick={() => void run()}>
        {t("providers.testRun.button")}
      </Button>
      <Show when={report() || error()}>
        <span class="testrun__result" role="status" data-ok={report()?.ok ? "" : undefined}>
          <Show when={report()} fallback={t("providers.testRun.failed", { error: error() ?? "" })}>
            {(r) => (
              <Show when={r().ok} fallback={t("providers.testRun.failed", { error: r().error ?? "" })}>
                {t("providers.testRun.ok", { ms: r().ms })}
                <Show when={r().model}>{(m) => <> {t("providers.testRun.model", { model: m() })}</>}</Show>
                <Show when={r().effective}>{(e) => <> {t("providers.testRun.mode", { mode: PERMISSION_LABEL[e().permission] })}</>}</Show>{" "}
                {r().negotiated ? t("providers.testRun.negotiated") : t("providers.testRun.notNegotiated")}
              </Show>
            )}
          </Show>
        </span>
      </Show>
    </span>
  );
}
