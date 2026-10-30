import { onMount } from "solid-js";
import { t } from "../../i18n";
import { FormGroup, FormRow, Switch } from "../../ui-kit";
import { mobilehealthEnabled, setMobilehealthEnabled, syncMobilehealthEnabled } from "./toggle";

/** Settings section: the toggle that shows the Mobile health panel and its command. */
export default function MobileHealthSection() {
  onMount(() => void syncMobilehealthEnabled());
  return (
    <FormGroup title={t("mobilehealth.section.title")} description={t("mobilehealth.section.desc")}>
      <FormRow label={t("mobilehealth.section.enable")} description={t("mobilehealth.section.enableDesc")}>
        <Switch checked={mobilehealthEnabled()} onChange={setMobilehealthEnabled} aria-label={t("mobilehealth.section.enableAria")} />
      </FormRow>
    </FormGroup>
  );
}
