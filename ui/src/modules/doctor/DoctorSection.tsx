import { onMount } from "solid-js";
import { t } from "../../i18n";
import { Button, FormGroup, FormRow, Switch } from "../../ui-kit";
import { openDoctor } from "./open";
import { setSetupDoctorEnabled, setupDoctorEnabled, syncSetupDoctorEnabled } from "./toggle";

/** Settings section: the toggle of the Setup doctor and a way to open it. */
export default function DoctorSection() {
  onMount(() => void syncSetupDoctorEnabled());
  return (
    <FormGroup title={t("setup.section.title")} description={t("setup.section.desc")}>
      <FormRow label={t("setup.section.enable")} description={t("setup.section.enableDesc")}>
        <Switch checked={setupDoctorEnabled()} onChange={setSetupDoctorEnabled} aria-label={t("setup.section.enable")} />
      </FormRow>
      <FormRow label={t("setup.section.open")}>
        <Button size="sm" variant="secondary" disabled={!setupDoctorEnabled()} onClick={() => openDoctor()}>{t("setup.section.openButton")}</Button>
      </FormRow>
    </FormGroup>
  );
}
