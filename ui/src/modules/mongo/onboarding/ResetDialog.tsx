import { createSignal, Show } from "solid-js";
import { t } from "../../../i18n";
import { ipc } from "../../../ipc";
import type { ResetReport } from "../../../ipc/mongo";
import { Button, Checkbox, CircleAlert, Dialog, Input, toast } from "../../../ui-kit";
import { codeOf, messageOf, refreshProfiles, wipeSecrets } from "../store";
import { patchPrefs } from "./prefs";
import { RESET_PHRASE } from "./logic";
import "../manage.css";

/**
 * Reset all: closes every connection and deletes every profile, every Keychain account of this feature, the saved SSH host keys
 * and the tunnel leftovers on this Mac, optionally the audit log. Local data only; the databases are not touched. Needs the typed
 * phrase, and works while the studio is switched off.
 */
export function ResetDialog(props: { onClose: () => void; onDone?: (r: ResetReport) => void }) {
  const [typed, setTyped] = createSignal("");
  const [auditToo, setAuditToo] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string>();
  const ok = () => typed().trim().toLowerCase() === RESET_PHRASE;

  async function run() {
    if (!ok() || busy()) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await ipc.mongo.resetAll(typed().trim(), { auditToo: auditToo() });
      wipeSecrets();
      await patchPrefs({ onboardingDone: false }).catch(() => undefined);
      await refreshProfiles();
      toast.success(t("mongoManage.reset.done", { profiles: r.profiles, secrets: r.secrets }));
      props.onDone?.(r);
      props.onClose();
    } catch (e) {
      setError(codeOf(e) === "mongoConfirm" ? t("mongoManage.reset.phraseWrong") : messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      size="md"
      role="alertdialog"
      closeOnBackdrop={false}
      onClose={props.onClose}
      title={t("mongoManage.reset.title")}
      description={t("mongoManage.reset.body")}
      footer={
        <>
          <Button variant="secondary" onClick={props.onClose}>{t("mongoManage.cancel")}</Button>
          <Button variant="danger" loading={busy()} disabled={!ok() || busy()} onClick={() => void run()}>{t("mongoManage.reset.button")}</Button>
        </>
      }
    >
      <form class="mm-io" onSubmit={(e) => (e.preventDefault(), void run())}>
        <ul class="mm-list">
          <li>{t("mongoManage.reset.profiles")}</li>
          <li>{t("mongoManage.reset.keychain")}</li>
          <li>{t("mongoManage.reset.files")}</li>
        </ul>
        <Checkbox size="sm" checked={auditToo()} onChange={setAuditToo} label={t("mongoManage.reset.audit")} />
        <p class="mm-hint">{t("mongoManage.reset.untouched")}</p>
        <div class="mm-field">
          <label class="mm-field__label" for="mm-reset-phrase">{t("mongoManage.reset.type", { phrase: RESET_PHRASE })}</label>
          <Input id="mm-reset-phrase" autocomplete="off" spellcheck={false} dir="ltr" data-autofocus value={typed()} invalid={!!typed() && !ok()} onInput={(e) => setTyped(e.currentTarget.value)} />
        </div>
        <Show when={error()}><p class="mm-banner" data-tone="danger" role="alert"><CircleAlert size={14} aria-hidden="true" /> <span>{error()}</span></p></Show>
      </form>
    </Dialog>
  );
}
