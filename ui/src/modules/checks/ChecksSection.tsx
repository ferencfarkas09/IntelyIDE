import { onMount } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Switch } from "../../ui-kit";
import { beforeCommit, checksEnabled, secretGuardEnabled, setBeforeCommit, setChecksEnabled, setSecretGuardEnabled, syncChecksSettings } from "./toggle";

/** Settings section: pre-commit checks, the secret-in-diff confirmation and the environment variable overview. */
export default function ChecksSection() {
  onMount(() => void syncChecksSettings());
  return (
    <FormGroup title={t("checks.section.title")} description={t("checks.section.desc")}>
      <FormRow label={t("checks.section.enable")} description={t("checks.section.enableDesc")}>
        <Switch checked={checksEnabled()} onChange={setChecksEnabled} aria-label={t("checks.section.enableAria")} />
      </FormRow>
      <FormRow label={t("checks.beforeCommit")} description={t("checks.section.beforeDesc")}>
        <Switch checked={beforeCommit()} onChange={setBeforeCommit} disabled={!checksEnabled()} aria-label={t("checks.beforeAria")} />
      </FormRow>
      <FormRow label={t("checks.section.secrets")} description={t("checks.section.secretsDesc")}>
        <Switch checked={secretGuardEnabled()} onChange={setSecretGuardEnabled} disabled={!checksEnabled()} aria-label={t("checks.section.secretsAria")} />
      </FormRow>
    </FormGroup>
  );
}
