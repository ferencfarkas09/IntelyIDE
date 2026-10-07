import { createSignal, createUniqueId, For, Show } from "solid-js";
import { t, type MessageKey } from "../../i18n";
import { ipc } from "../../ipc";
import { errorText } from "../../store/snapshots";
import { Button, Copy, RefreshCw, toast, TriangleAlert } from "../../ui-kit";
import type { ProviderInfo } from "../../ipc/providers";
import { sdkIssue, SDK_SETUP_COMMANDS, type SdkIssue } from "./logic";

const NOTES = ["private", "verified", "npm", "terms", "safe"] as const;

/** Shown inside the Claude card while the Agent SDK is missing, of another version, unverified or broken. Nothing here installs anything. */
export function SdkCard(props: { issue: SdkIssue; onChange: (next: ProviderInfo) => void }) {
  const id = createUniqueId();
  const [busy, setBusy] = createSignal(false);
  const [result, setResult] = createSignal<"still" | "ok" | null>(null);
  const commands = SDK_SETUP_COMMANDS.join("\n");

  async function recheck() {
    setBusy(true);
    setResult(null);
    try {
      const claude = (await ipc.providers.detect()).find((x) => x.id === "claude");
      if (claude) {
        props.onChange(claude);
        setResult(sdkIssue(claude) ? "still" : "ok");
      }
    } catch (e) {
      toast.error(t("providers.sdk.recheckFailed"), errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const copy = () => void navigator.clipboard?.writeText(commands).then(() => toast.info(t("providers.sdk.copied")), () => undefined);

  return (
    <section class="sdkcard" role="group" aria-labelledby={`${id}-t`} data-code={props.issue.code}>
      <h5 class="sdkcard__title" id={`${id}-t`}>
        <TriangleAlert size={14} aria-hidden="true" /> {t(`providers.sdk.title.${props.issue.code}` as MessageKey)}
      </h5>
      <p class="sdkcard__lead">{t(`providers.sdk.lead.${props.issue.code}` as MessageKey)}</p>
      <Show when={props.issue.detail}>
        <p class="sdkcard__detail">
          <span>{t("providers.sdk.detail")}</span> <code>{props.issue.detail}</code>
        </p>
      </Show>
      <p class="sdkcard__steps-title">{t("providers.sdk.stepsTitle")}</p>
      <pre class="sdkcard__code" dir="ltr" tabIndex={0} aria-label={t("providers.sdk.stepsAria")}>{commands}</pre>
      <ul class="sdkcard__notes">
        <For each={NOTES}>{(n) => <li>{t(`providers.sdk.note.${n}` as MessageKey)}</li>}</For>
      </ul>
      <div class="sdkcard__actions">
        <Button size="sm" variant="secondary" icon={Copy} onClick={copy}>{t("providers.sdk.copy")}</Button>
        <Button size="sm" icon={RefreshCw} loading={busy()} onClick={() => void recheck()}>{busy() ? t("providers.sdk.rechecking") : t("providers.sdk.recheck")}</Button>
        <Show when={result()}>
          {(r) => <span class="sdkcard__result" role="status" data-ok={r() === "ok" ? "" : undefined}>{r() === "ok" ? t("providers.sdk.nowOk") : t("providers.sdk.stillIssue")}</span>}
        </Show>
      </div>
    </section>
  );
}
