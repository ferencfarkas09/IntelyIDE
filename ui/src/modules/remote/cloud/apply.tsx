import { createSignal, Show } from "solid-js";
import { t } from "../../../i18n";
import { announce, Button, Dialog } from "../../../ui-kit";
import { refreshRemote, remoteView, isOn } from "../state";
import { cloudApi } from "./api";
import { ErrorSummary } from "./common";
import { errorCodeOf, errorDetailOf, hostChanges } from "./logic";
import { refreshCloud } from "./store";
import type { RelayMode } from "./types";

/**
 * "Use this relay now": the one gesture that applies a relay live. Switching to another host unpairs every phone (their address and
 * passkeys are bound to it), so with paired phones a confirmation comes first; Rust enforces it too (`needsRepair`).
 */
export function createApplier(mode: RelayMode, targetUrl: () => string | null, onApplied?: () => void, exec?: (confirmUnpair: boolean) => Promise<void>) {
  const [ask, setAsk] = createSignal<number | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [code, setCode] = createSignal<string | null>(null);

  const apply = async (confirmUnpair: boolean) => {
    setBusy(true);
    setCode(null);
    try {
      await (exec ? exec(confirmUnpair) : cloudApi().apply({ mode, confirmUnpair }));
      await Promise.all([refreshRemote().catch(() => {}), refreshCloud().catch(() => {})]);
      setAsk(null);
      announce(t("remote.cloud.applied"));
      onApplied?.();
    } catch (e) {
      if (errorCodeOf(e) === "needsRepair") setAsk(Number(errorDetailOf(e)) || remoteView()?.devices.length || 1);
      else setCode(errorCodeOf(e));
    } finally {
      setBusy(false);
    }
  };
  const start = () => {
    const devices = remoteView()?.devices.length ?? 0;
    const url = targetUrl();
    if (devices > 0 && url && hostChanges(remoteView()?.relay ?? "", url)) setAsk(devices);
    else void apply(false);
  };

  const dialog = () => (
    <Dialog
      open={ask() !== null}
      onClose={() => setAsk(null)}
      title={t("remote.cloud.unpair.title")}
      size="sm"
      role="alertdialog"
      description={t("remote.cloud.unpair.body", { n: ask() ?? 0 })}
      footer={
        <>
          <Button variant="ghost" onClick={() => setAsk(null)}>
            {t("remote.cloud.cancel")}
          </Button>
          <Button variant="danger" loading={busy()} onClick={() => void apply(true)} data-testid="unpair-confirm">
            {t("remote.cloud.unpair.confirm")}
          </Button>
        </>
      }
    >
      <p class="cloud-note">{isOn() ? t("remote.cloud.unpair.panic") : t("remote.cloud.unpair.off")}</p>
      <Show when={code()}>
        <ErrorSummary code={code()} />
      </Show>
    </Dialog>
  );
  return { start, busy, code, dialog };
}
