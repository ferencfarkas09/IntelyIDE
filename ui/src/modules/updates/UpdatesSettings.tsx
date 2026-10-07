import { createSignal, Show } from "solid-js";
import { t, fmt } from "../../i18n";
import { ipc } from "../../ipc";
import { Button, FormGroup, FormRow, Switch } from "../../ui-kit";
import { applyNotice, checkNow, errorText, updateNotice } from "./state";
import "./updates.css";

/** Settings > Updates: the switch, "Check now", the last check and the skipped version. */
export default function UpdatesSettingsPage() {
  const [busy, setBusy] = createSignal(false);
  void ipc.updates.status().then(applyNotice, () => undefined);
  const n = () => updateNotice();
  async function check() {
    setBusy(true);
    try {
      await checkNow();
    } catch {
      /* the result line shows the state; a rejected call leaves it as it was */
    } finally {
      setBusy(false);
    }
  }
  const result = () => {
    const x = n();
    if (!x) return "";
    switch (x.state) {
      case "available":
        return t("updates.result.available", { version: x.latest?.version ?? "" });
      case "upToDate":
        return t("updates.result.upToDate", { version: x.currentVersion });
      case "error":
        return errorText(x.error);
      case "checking":
        return t("updates.result.checking");
      case "disabled":
        return x.error ? errorText(x.error) : t("updates.result.off");
      default:
        return "";
    }
  };
  return (
    <div class="sc-section">
      <FormGroup title={t("updates.section.name")} description={t("updates.honest")}>
        <FormRow label={t("updates.auto")} description={t("updates.disclosure")}>
          <Switch checked={n()?.enabled ?? true} onChange={(enabled) => void ipc.updates.setEnabled(enabled).then(applyNotice)} aria-label={t("updates.auto")} />
        </FormRow>
        <FormRow label={t("updates.check")} description={t("updates.lastChecked", { when: n()?.lastCheckedAt ? fmt.relative(n()!.lastCheckedAt! * 1000) : t("updates.never") })}>
          <div class="upd-check">
            <Button size="sm" loading={busy()} onClick={() => void check()}>{t("updates.check")}</Button>
            <span class="upd-check__result" role="status" aria-live="polite">{result()}</span>
          </div>
        </FormRow>
        <Show when={n()?.dismissedVersion}>
          <FormRow label={t("updates.skipped", { version: n()!.dismissedVersion! })} description={t("updates.skippedDesc")}>
            <Button size="sm" variant="ghost" onClick={() => void ipc.settings.set("updates", { dismissedVersion: null }).then(() => ipc.updates.status().then(applyNotice))}>{t("updates.unskip")}</Button>
          </FormRow>
        </Show>
      </FormGroup>
    </div>
  );
}
